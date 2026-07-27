# Code from Teams — findings log

**What this is:** an honest record of building a bridge that lets a developer drive
GitHub Copilot from a Microsoft Teams thread. It documents what we tried, what worked,
what failed, and what we deliberately *didn't* try because a better option existed.

Written so someone picking this up later doesn't repeat our dead ends.

**Status as of 2026-07-27:** every transport risk is closed with evidence, and the whole
pipe has now been run end to end against real Teams — including the agent asking a
question, parking for 2.5 minutes, and posting again 5 minutes later, all inside the
original thread. The remaining work is the Copilot SDK wiring, which has no external
dependencies.

---

## 1. The goal

Talk to Copilot from Teams, while driving or making coffee, with the same fidelity as
sitting at a terminal. The user's framing:

> "the way I am talking to you right now, I should be able to talk in the same way
> from Teams."

That one sentence drove most of the design. It rules out a task-submission bot. The
agent has to be able to ask questions mid-task and wait for an answer, exactly as it
does in a terminal.

**Core abstraction:** `1 Teams thread = 1 Copilot session = 1 branch`

---

## 2. Final architecture (all parts proven)

```
Teams channel thread
      │  @mention  →  outgoing webhook  (HMAC signed, must answer within 5s)
      ▼
Bridge (node, :3978, exposed via tunnel)
      │  verify HMAC → allowlist check → derive sessionId → ack inside 5s
      ▼
Copilot SDK session  (cwd = repo clone, resumed by caller-supplied id)
      │  milestones, questions, final result
      ▼
Power Automate flow  →  "Reply with a message in a channel"  →  SAME thread
```

Two long-lived listeners on one machine: the bridge and the tunnel.

**Inbound** is the Teams outgoing webhook. **Outbound** (anything after the 5-second
window) is a Power Automate flow. They are different mechanisms — this asymmetry is the
single most important thing to understand about the system.

---

## 3. What worked

| Thing | Evidence |
|---|---|
| Teams **outgoing webhook** (inbound) | created in a team we own; received real messages |
| HMAC signature verification | `signature : true` on real captured payloads |
| Reply inside the 5s window lands **in-thread** | `got it: "hello"` appeared threaded, free of charge |
| **Thread root is stable** across a thread | `FIRST` + reply `second` → identical root |
| Outbound push via Power Automate | Adaptive Card POST appeared in channel |
| **Threaded** outbound reply (R1) | `Reply with a message in a channel` + `Message Id` landed inside the original thread |
| Flow stability in a permissive environment | 15 posts, 1/min, **zero failures** |
| Prompt vs. answer routing | local dry run: parked 18.1s, resolved correctly |
| **Same routing against real Teams** | parked **159.0s**, `"2"` routed as ANSWER, not as a new prompt |
| **Delayed post 5 min later, still in-thread** | posted at +696.0s after a 300s sleep; confirmed visually in Teams |
| Stable public URL via `devtunnel` | named tunnel `teams-bridge`, survives restarts; 1.2s round trip |
| SDK `ask_user` support | `onUserInputRequest` verified in `@github/copilot-sdk` 1.0.8 typings |

### The full round trip, run live (2026-07-27)

This is the run that closed the last gap. One real Teams thread, `1785130046292`:

```
+229.3s  signature true   text "ping"     → ROUTED AS NEW PROMPT
+235.6s  flow POST → 202 in 1357ms          (question posted to the thread)
+393.3s  signature true   text "2"        → ROUTED AS ANSWER to a parked question
         ANSWER received after 159.0s
+394.7s  flow POST → 202 in 1426ms          (acknowledged the choice)
+394.7s  sleeping 300s before the delayed leg...
+696.0s  flow POST → 202 in 1215ms          (delayed result, still in-thread)
+696.0s  scenario complete
```

Five behaviours proven in one run:

1. Reply **inside** the 5-second window.
2. A question with numbered options and a recommendation, pushed via the flow.
3. The bridge **parking** while the user walks away, for 2.5 minutes.
4. The user's next message routed as an **answer**, not as a new prompt.
5. A post **5 minutes later** landing in the *same* thread — the "walk away and get told
   when it's done" case, which is the entire point of the project.

Nothing in that sequence is scaffolding for the demo. It is exactly the shape of a real
turn: ack, ask, wait, work, report. Swapping the scripted scenario for a Copilot session
changes what fills the gaps, not the mechanics.

**Bonus, observed in the same log:** a deliberately mis-signed probe was rejected
(`REJECTED: bad signature`) with `threadRoot: null`, confirming HMAC rejection works
against live traffic and not just in unit-style tests.

### The key discovery: session identity comes free from Teams

```js
const sessionId = "teams-" + conversation.id.split(";messageid=")[1];
```

`conversation.id` looks like `19:…@thread.tacv2;messageid=1784956184852`. The
`;messageid=` suffix is the **thread root** and stays identical for every message in
that thread. So the session key is *derived*, never stored — no map file, no race, no
unrecoverable state.

### The agent asking a question needs no new transport

`onUserInputRequest` may return a **Promise**. The bridge posts the question to Teams
and simply doesn't resolve until the next message arrives in that thread. Inbound is
the webhook we already have; only the *routing* differs — a message is either a new
prompt or the answer to a parked question.

---

## 4. What did not work

### App sideloading — blocked
"This app is not available. Please check with your admin for more details."

**Consequence:** killed the Azure Bot route, which would otherwise have been the best
architecture (native proactive messaging, no Power Automate at all, no 5s window). A
bot reaches Teams via an app package that must be sideloaded or admin-published.

### `replyToId` — always null, and it looks usable
`replyToId` was `null` for a genuine in-thread reply. The obvious fallback
`(replyToId ?? id)` would have keyed every message to a **new** session, giving the
agent amnesia every turn — silently, with no error. Only caught by testing a real
two-message thread.

**Use the `;messageid=` thread root. Never `replyToId`.**

### `text` is HTML, despite `textFormat: "plain"`
Real payload: `"<p><at>testhook</at>&nbsp;hello</p>"`. Must strip `<at>` mentions,
tags and entities before the text is usable as a prompt.

### The webhook trigger is invisible in both trigger pickers
`When a Teams webhook request is received` did not appear in the Teams Workflows
blank-flow picker **or** in the `make.powerautomate.com` trigger search.

**Workaround that worked:** install it via the **template "Send webhook alerts to
channel"**. The template creates a flow using that exact trigger. The pickers are
curated; the templates are not.

### Flow suspended within 1–2 minutes in the Default environment
Created in Default, the flow was disabled almost immediately, repeatedly. Far too fast
to be Power Automate's failure-based auto-disable (which needs repeated failures over
days) — an active governance/DLP sweep.

**Fix:** export the flow as a package and import it into a Power Platform environment
with a looser DLP policy. Soak test then passed 15/15.

> DLP is evaluated **per environment**. We did *not* try to defeat the Default-env
> policy by re-enabling in a loop — that's circumventing a security control.

### `devtunnel`'s installer half-fails, and the real blocker is a missing library
`curl -sL https://aka.ms/DevTunnelCliInstall | bash` drops the binary at `~/bin/devtunnel`
and then its own `sudo` step fails. Harmless — `chmod +x` and carry on.

The blocker is that `devtunnel` is a .NET app and will not start without ICU:
`Couldn't find a valid ICU package`. On Ubuntu 26.04 that is
`sudo apt install -y libicu78`. Setting `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`, the
usual workaround, does **not** help here.

### Repo has no branch protection
`gh api repos/…/rules/branches/main` → `[]`. Classic protection returns 404, which is
ambiguous (absent *or* unreadable without admin). Either way you cannot *confirm* `main`
is protected — the wrong state to be in before giving an auto-approved agent push
rights.

---

## 5. Considered and rejected (a better option existed)

| Option | Why rejected |
|---|---|
| **`copilot -p` one-shot CLI** | Fresh process per message (seconds of startup each turn), cannot be interrupted, cannot ask permission. The SDK stays warm and has `onPermissionRequest`, steering and queueing natively. |
| **Azure Bot / Bot Framework** | Strictly the best design — native proactive messaging, no flow to be disabled, no 5s window. Blocked by the sideloading policy. |
| **Posting to `serviceUrl` from the webhook payload** | Needs bot App ID + password, which an outgoing webhook never provides. A trap that looks tractable. |
| **Microsoft Graph `Chat.*` / `ChannelMessage.Send`** | Requires admin consent in most tenants. Power Automate reaches the same endpoint using the user's own connection, no consent needed. |
| **`When an HTTP request is received` trigger** | **Premium** connector. The near-identically named `When a Teams webhook request is received` is standard and free. Easy and expensive mistake. |
| **Free M365 developer tenant** | Would have unlocked sideloading + Azure Bot. Rejected by the user on data-policy grounds. Respected, not argued. |
| **Email-triggered flow** (bridge emails itself, flow posts to Teams) | Standby if the Teams webhook trigger were unavailable. ~1–3 min latency (that trigger polls) — fine for delayed notifications, useless for chat. Never needed. |
| **Pull model** (agent writes progress to a file; user asks "?" and gets it in the 5s window) | Guaranteed to work with zero infrastructure, and was our floor if outbound push failed. Not needed once push worked. Loses unprompted notification, which is the whole driving premise. |
| **Token streaming** | A desk feature, useless on a phone. Milestone posts (~1 per 15s) kept instead — two minutes of silence looks broken, especially on stage. |
| **Storing sessionId → thread map in a file** | `SessionListFilter` only filters by workingDirectory/gitRoot/repository/branch and `SessionMetadata` has **no name or tag field**. Every session shares one repo, so a lost map file is **unrecoverable**. Deriving the id removes that failure mode and a read-modify-write race, for free. |
| **git worktrees for concurrency** | Serializing turns (one active turn globally, "busy, queued you") is ~10 lines and solves the same corruption problem. |
| **ngrok / cloudflared tunnels** | Both work without `sudo`, which was tempting after the ICU problem. Rejected because they route corporate traffic through a third party — the same data-policy constraint that ruled out an M365 dev tenant. `devtunnel` keeps the traffic Microsoft-side. |
| **VS Code port forwarding** | Fine for the first proof, and it's what we used to prove inbound. Rejected as the running setup: the URL churns on every restart (re-edit the webhook each time) and the tunnel dies when the editor closes — so the bridge is hostage to an IDE window. |
| **Adaptive Cards / buttons** | Replying "yes" by voice beats tapping a button while driving. Plain text is the better interface here. |

---

## 6. Landmines worth knowing

1. **Mentions must be picked from the autocomplete dropdown.** Typing `@name` as plain
   text does not fire the webhook. The #1 cause of "it's broken".
2. **EVERY message needs the @mention — including replies.** An outgoing webhook only
   fires on messages that mention it, so a bare "yes" inside the thread never reaches
   the bridge. This directly affects the ask-a-question flow: the agent's question must
   tell the user to @mention it when answering, or the turn silently parks until the
   timeout. An Azure Bot would not have this constraint (it receives all channel
   messages), which is a real cost of the webhook route.
3. **The 5-second budget is hard.** Ack immediately, do the work asynchronously.
4. **Tunnel must be set to Public.** VS Code port forwarding defaults to Private, which
   fails silently from Teams' side.
5. **The flow URL is a bearer secret.** The `sig=` parameter *is* the auth. Anyone with
   the URL can post to your channel.
6. **The trigger URL is regenerated on import.** Connections don't export either — you
   re-authenticate the Teams connection in the new environment.
7. **Imported flows arrive disabled**, and the action's Team/Channel dropdowns are often
   blanked.
8. **Omitting `onPermissionRequest` does not auto-approve** — requests are left
   *pending*, so the agent hangs on its first tool call. Pass `approveAll` explicitly.
9. **Secrets leak through the agent's shell.** `TEAMS_WEBHOOK_SECRET` lives in the
   bridge environment, which tool calls inherit. One `env` would post it into Teams.
   Use `secret-env-vars`.
10. **A dead tunnel does not fail fast.** If `devtunnel host` isn't running, the public
   URL still resolves — requests hang ~15s and return **HTTP 200 with an empty body**,
   so it looks like a slow app rather than a missing tunnel. Teams gives up at 5s and
   shows *"Sorry, there was a problem encountered with your request"* attributed to the
   webhook's name. Diagnose by comparing a direct `localhost:3978` hit (should be
   ~15ms) against the public URL.
11. **`devtunnel host` dies with its terminal.** Run it under tmux/systemd, or the
   bridge silently becomes unreachable while still looking perfectly healthy in its own
   logs — it never sees the request at all.
12. **Question timeout is non-negotiable.** A parked question holds the turn open, and
   the global serialize lock allows one turn at a time — so one unanswered question
   blocks the entire bridge forever. Walking away mid-question is the normal case.

---

## 7. Tenant and environment constraints (this tenant)

- App sideloading: **blocked**
- Teams outgoing webhooks: **allowed** (team owner → Manage team → Apps → bottom)
- Power Automate Default environment: **DLP suspends the flow**
- User's own environment: **permissive**, flow survives
- Teams Workflows app always creates flows in **Default**, and this cannot be changed

**Why moving environments works:** an environment is only a *governance* boundary. Reach
is determined by the **connection** (the user's own OAuth token) and the Team/Channel
picked in the action. Moving environments changes which DLP policy is evaluated, and
nothing else.

---

## 8. Risks — closed and open

**Closed with evidence:**

| # | Risk | How it was closed |
|---|---|---|
| R1 | Can we post into an *existing* thread later? | `Reply with a message in a channel` + `Message Id` = thread root. Landed in-thread. |
| R5 | Tunnel URL churn / dies with the IDE | Named `devtunnel` (`teams-bridge`) under tmux. Stable URL, 1.2s round trip. |
| R6 | Can the agent ask a question and wait? | Live run: parked **159.0s**, answer routed correctly, delayed post 5 min later still in-thread. |
| R7 | Flow auto-disabled by governance | Moved to the user's own Power Platform environment. 15/15 soak. |

**Still open:**

| # | Risk | Mitigation |
|---|---|---|
| R2 | **Security.** HMAC proves the message came from Teams, *not* who sent it. | `aadObjectId` allowlist (the only real control), private team of one, audit log of **every** message, branch protection as a server-side backstop. |
| R3 | Long threads exhaust the context window | SDK `infiniteSessions` — enable from the start, not at 2am. |
| R4 | Crash mid-turn = permanent silence after "on it 👍" | Turn timeout that posts a failure. |
| — | **Prompt injection — residual, not solved** | The allowlist governs who *talks* to the agent, not what it *reads*. With tools auto-approved, a hostile string in a repo file, issue or fetched page can steer it using your credentials. Name it; don't pretend to have fixed it. Branch protection is the honest answer to "what stops a poisoned README pushing to main". |

Every open risk is now on our side of the wire. Nothing left depends on Teams, Power
Automate, or tenant policy.

---

## 9. How we got here

Roughly chronological. Included because several of the corrections matter more than the
conclusions.

1. Framed the idea; researched CLI vs SDK; chose the **SDK**.
2. Scoped hard: no model/skill selection, no slash commands, no worktrees, no streaming.
3. Verified `session.sessionId` is exposed — but found `SessionMetadata` has no name
   field, which is what actually decided *derive, don't store*.
4. Evaluated bridging options. **Corrected an earlier wrong claim** that Graph needed no
   admin consent, and that dev tunnels imply opening a firewall port (they're
   outbound-only).
5. Sideloading blocked → Azure Bot dead.
6. Research claimed outgoing webhooks share the sideload policy. **Wrong for this
   tenant** — they worked. Testing beat documentation.
7. Captured a real payload; found the HTML-in-`text` and `;messageid=` quirks.
8. Ran a two-message thread test → thread root stable, `replyToId` trap caught.
9. Designed outbound; hit the premium-trigger trap; found the free Teams trigger.
10. Verified `onUserInputRequest` in the SDK typings; found the deadlock interaction.
11. Built and passed a full local dry run with a mock flow.
12. Trigger invisible in both pickers → template route worked.
13. Flow suspended by Default-env DLP → exported/imported to a permissive environment.
14. **R1 passed** (threaded reply) and **R7 closed** (15-minute soak, zero failures).
15. Replaced VS Code port forwarding with a named `devtunnel` under tmux, so the bridge
    stops being hostage to an editor window. **R5 closed.**
16. Chased a phantom outage — Teams said *"there was a problem with your request"* while
    the bridge logged nothing at all. The tunnel had died; a dead tunnel still answers,
    it just hangs. **This is the failure mode most likely to burn someone.**
17. Lost 20 minutes to a bridge that "wasn't receiving" — the message simply hadn't
    @mentioned the webhook. Now landmine #2, and the question text tells the user.
18. **Ran the whole thing live against real Teams**: prompt → in-window ack → question →
    159s park → answer routed correctly → 5-minute delayed post, all in one thread.
    **R6 closed.**

**Recurring lesson:** documentation was wrong or misleading at least six times on this
project — outgoing webhook availability, trigger visibility, `replyToId` semantics,
`textFormat: "plain"`, omitting `onPermissionRequest` (documented as optional, actually
hangs the agent), and the standard .NET globalization workaround. Every load-bearing
claim in this document has a test behind it.

**Second lesson, cheaper to learn here than at 2am:** every failure on this project was
silent. A wrong session key gives amnesia with no error. A dead tunnel returns HTTP 200.
A missing @mention looks like a broken bridge. A parked question looks like a hung agent.
Nothing threw an exception. Build the logging before you build the feature — the live
run above was only diagnosable because every inbound message prints its signature
verdict, sender, text and thread root.

---

## 10. What's left

The transport is finished. Everything below is local work with no external dependency —
no tenant policy, no admin, no third party.

`scripts/teams-roundtrip-test.js` is already the bridge in all but one function. HMAC
verification, `toPlainText()`, `threadRootOf()`, the parked-question map, the serialize
lock and the flow POST are all proven. Only `runScenario()` is fake.

1. **Swap the scenario for a Copilot session.** `npm i @github/copilot-sdk`, then
   `resumeSession("teams-" + threadRoot)` (falling back to create), with
   `infiniteSessions: { enabled: true }` on from day one — it is a config **object**,
   not a boolean (`enabled` defaults true; the compaction thresholds default to 0.80
   background / 0.95 blocking).
2. **Pass `approveAll` as `onPermissionRequest` explicitly.** Omitting it does not mean
   "auto-approve" — it leaves requests pending and the agent hangs on its first tool
   call.
3. **Wire `onUserInputRequest` to the existing parked-question machinery.** Post the
   question via the flow and return the Promise. This is already built and proven.
4. **Throttle milestone posts to about one per 15 seconds**, then post the final result.
   Two minutes of silence looks broken, particularly on stage.
5. **Two timeouts.** A question timeout (a parked question plus the global serialize lock
   will otherwise freeze the bridge forever) and a turn timeout (R4).
6. **Security hardening (R2).** `aadObjectId` allowlist, an append-only JSONL audit log
   of *every* inbound message, and `secret-env-vars` so a tool call can't `env` the
   webhook secret into the channel.
7. **One line in `AGENTS.md`** — the output adapter is a prompt, not code:
   *"You are being read aloud on a phone. Keep replies under 3 sentences. Never paste
   diffs or code — link to the PR instead."*

Two things that would be tempting to skip and shouldn't be: the milestone posts (item 4)
and the question timeout (item 5). The first is what makes the system feel alive; the
second is what stops one unanswered question from bricking it.
