# Code from Teams — findings log

**What this is:** an honest record of building a bridge that lets a developer drive
GitHub Copilot from a Microsoft Teams thread. It documents what we tried, what worked,
what failed, and what we deliberately *didn't* try because a better option existed.

Written so someone picking this up later doesn't repeat our dead ends.

**Status as of 2026-07-25:** every transport risk is closed with evidence. Both
directions of the Teams pipe are proven against real messages. The remaining work is
the Copilot SDK wiring, which has no external dependencies.

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
| SDK `ask_user` support | `onUserInputRequest` verified in `@github/copilot-sdk` 1.0.8 typings |

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
| **Adaptive Cards / buttons** | Replying "yes" by voice beats tapping a button while driving. Plain text is the better interface here. |

---

## 6. Landmines worth knowing

1. **Mentions must be picked from the autocomplete dropdown.** Typing `@name` as plain
   text does not fire the webhook. The #1 cause of "it's broken".
2. **The 5-second budget is hard.** Ack immediately, do the work asynchronously.
3. **Tunnel must be set to Public.** VS Code port forwarding defaults to Private, which
   fails silently from Teams' side.
4. **The flow URL is a bearer secret.** The `sig=` parameter *is* the auth. Anyone with
   the URL can post to your channel.
5. **The trigger URL is regenerated on import.** Connections don't export either — you
   re-authenticate the Teams connection in the new environment.
6. **Imported flows arrive disabled**, and the action's Team/Channel dropdowns are often
   blanked.
7. **Omitting `onPermissionRequest` does not auto-approve** — requests are left
   *pending*, so the agent hangs on its first tool call. Pass `approveAll` explicitly.
8. **Secrets leak through the agent's shell.** `TEAMS_WEBHOOK_SECRET` lives in the
   bridge environment, which tool calls inherit. One `env` would post it into Teams.
   Use `secret-env-vars`.
9. **A dead tunnel does not fail fast.** If `devtunnel host` isn't running, the public
   URL still resolves — requests hang ~15s and return **HTTP 200 with an empty body**,
   so it looks like a slow app rather than a missing tunnel. Teams gives up at 5s and
   shows *"Sorry, there was a problem encountered with your request"* attributed to the
   webhook's name. Diagnose by comparing a direct `localhost:3978` hit (should be
   ~15ms) against the public URL.
10. **`devtunnel host` dies with its terminal.** Run it under tmux/systemd, or the
   bridge silently becomes unreachable while still looking perfectly healthy in its own
   logs — it never sees the request at all.
11. **Question timeout is non-negotiable.** A parked question holds the turn open, and
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

## 8. Open risks

| # | Risk | Mitigation |
|---|---|---|
| R2 | **Security.** HMAC proves the message came from Teams, *not* who sent it. | `aadObjectId` allowlist (the only real control), private team of one, audit log of **every** message, branch protection as a server-side backstop. |
| R3 | Long threads exhaust the context window | SDK `infiniteSessions` — enable from the start, not at 2am. |
| R4 | Crash mid-turn = permanent silence after "on it 👍" | Turn timeout that posts a failure. |
| R5 | Tunnel URL churn on restart | `devtunnel` CLI gives a stable named URL. |
| — | **Prompt injection — residual, not solved** | The allowlist governs who *talks* to the agent, not what it *reads*. With tools auto-approved, a hostile string in a repo file, issue or fetched page can steer it using your credentials. Name it; don't pretend to have fixed it. Branch protection is the honest answer to "what stops a poisoned README pushing to main". |

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

**Recurring lesson:** documentation was wrong or misleading at least four times on this
project — outgoing webhook availability, trigger visibility, `replyToId` semantics, and
`textFormat: "plain"`. Every load-bearing claim in this document has a test behind it.
