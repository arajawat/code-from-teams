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
      │  model + effort + voice prompt, set on BOTH create and resume
      │  milestones, questions, final result
      ▼
Power Automate flow  →  "Reply with a message in a channel"  →  SAME thread
```

Two long-lived listeners on one machine: the bridge and the tunnel.

**Inbound** is the Teams outgoing webhook. **Outbound** (anything after the 5-second
window) is a Power Automate flow. They are different mechanisms — this asymmetry is the
single most important thing to understand about the system.

Everything that is not a secret is a file you edit and reload: `bridge.config.json` for
which repo, model, effort and allowlist, and `prompts/teams-voice.md` for how the replies
sound. Secrets stay in the environment and are stripped before the agent is spawned.

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
`Couldn't find a valid ICU package`.

**Install `libicu-dev`, never `libicu<NN>`.** The runtime package carries a soname
version that changes with every distro release — `libicu70` on Ubuntu 22.04, `libicu74`
on 24.04, `libicu78` on 26.04 — so a pinned name works on exactly one release and fails
on every other with `Package 'libicuNN' has no installation candidate`. That is a
confusing error, because it reads like the package was withdrawn rather than renamed.
`libicu-dev` exists on every Debian/Ubuntu release and depends on whichever runtime is
correct there:

```sh
sudo apt install -y libicu-dev
```

Setting `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`, the usual workaround for a .NET app
with no ICU, does **not** help here.

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
9. **Secrets leak through the agent's shell.** `TEAMS_WEBHOOK_SECRET` and
   `TEAMS_FLOW_URL` live in the bridge environment, which spawned tool calls inherit.
   One `env` would post them into Teams. **`secret-env-vars` is a CLI setting and does
   not exist in the SDK** — do not go looking for it. Strip them from the environment
   the agent is spawned into instead: copy `process.env`, `delete` both keys, pass the
   copy as `env` on `CopilotClient`. A wall, not a filter — the agent cannot print what
   it was never given.
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
13. **The global git identity is often unset**, and a repo-local one hides it. The agent
   works for minutes, runs `git commit`, and hits *"Please tell me who you are"* buried
   in tool output — indistinguishable from the agent deciding not to commit. Validate
   `user.name`/`user.email` at **startup**, not at commit time.
14. **Model and reasoning effort must be set on resume, not just create.** They live on
   `SessionConfigBase`, which both `SessionConfig` and `ResumeSessionConfig` extend. A
   thread resumes on every turn after the first, so setting them only on create gives
   you one good turn and then a silent drop back to the default — which is `medium`,
   not the model default you assumed.
15. **`aadObjectId` casing is not guaranteed.** GUIDs compared case-sensitively will
   lock you out of your own bridge with a rejection message that explains nothing.
   Lowercase both sides.
16. **The tunnel's 30-day expiry is inactivity-based, not absolute.** Good news for
   normal use — the clock never starts. Bad news for a long pause: let it lapse and the
   URL changes, which means editing the Teams webhook by hand.
17. **`session.idle` is an event, not a state to poll**, and the assistant's text is at
   `data.content` — there is no `.text`. Both are written down elsewhere in these docs
   and I still got them wrong writing a throwaway probe. Copy the bridge's event loop;
   do not reconstruct it from memory.
18. **Never pin a `libicu<NN>` version in setup instructions** — use `libicu-dev`. The
   soname tracks the distro release (`libicu70` on 22.04, `libicu74` on 24.04,
   `libicu78` on 26.04), so a version copied off a working machine fails on every other
   one with `Package 'libicuNN' has no installation candidate` — which reads like the
   package was withdrawn, not renamed, and sends you looking for a PPA you do not need.
   A whole class of bug: **setup instructions written from one machine are untested
   until a second machine runs them.** Anything version-specific in a runbook is a
   latent failure that only surfaces at the least convenient moment.
19. **`devtunnel` is not on `PATH` after install.** The installer drops it at
   `~/bin/devtunnel`, and Ubuntu's `~/.profile` adds `~/bin` to `PATH` **only if that
   directory already existed at login** — the installer creates it mid-session, so a
   bare `devtunnel` gives `command not found` until you log out and back in. Call it by
   full path. Worth noting *how* this survived: the tmux commands always used
   `~/bin/devtunnel`, so the working system never exercised the broken instruction, and
   it was wrong on the machine it was written on too. **A runbook step that your own
   running setup never executes is not verified by that setup working.**
20. **A tunnel hosts from one machine only — a second host silently evicts the first,
   and the first never comes back.** This is the nastiest failure on the list because
   every indicator lies. The evicted machine's log says
   `Connection to host tunnel relay closed. Another host for the tunnel has connected.`
   and then nothing: the process stays alive, the tmux session stays alive, `ps` shows
   it running. `devtunnel show` reports `Host connections: 1` throughout — the counter
   never reveals a conflict, because from the service's view there genuinely is one
   host, just not the one you think. Killing the second host does **not** hand the
   tunnel back; the public URL then times out entirely (`000`, no response), which is
   a *third* distinct failure signature on top of the fast-502 and the empty-200.
   Recovery is to kill and restart the tunnel's tmux session. Practical rule: **only
   one machine hosts at a time.** Stop the old host before starting the new one, and
   treat "let me just host it on the new box to check" as an outage on the old one.
21. **`devtunnel user login` hangs forever on WSL with no output at all.** It defaults
   to browser auth and calls `xdg-open`, which exists on WSL but has no handler behind
   it — so it exits `0` having done nothing and the CLI waits for a callback nobody
   will make. Install an `xdg-open` shim that calls `powershell.exe Start-Process` (or
   install `wslu`), then `devtunnel user login -b -e`. **Do not fall back to `-d`**:
   device code is usually blocked by Conditional Access in a managed tenant, and worse,
   *starting* one clears the credential you already had even if you abort — a running
   host keeps serving, so you don't find out until the next restart. See §21.
22. **`create` is once per *account*, not once per machine — and re-running it gives
   advice that cannot work.** On a second machine, `devtunnel create teams-bridge`
   fails with `Conflict with existing entity. Retry tunnel operation.` The "Retry"
   suggestion is actively misleading: this is not a transient conflict, the entity
   permanently exists, and no number of retries will change that. Read it as *"I
   already exist"* — it is really confirmation you are signed into the correct account,
   because a wrong account would not see a conflict at all. Skip both `create` and
   `port create`, and go straight to `devtunnel host teams-bridge`.

23. **A tmux session inherits the environment of the shell that started the tmux
   *server*, not the shell that ran `tmux new`.** `PATH` and your own variables are not
   in `update-environment`, so `export SECRET=... ; tmux new -d -s bridge ...` hands the
   bridge nothing if a server was already running — it starts with HMAC verification
   **off**, accepting unauthenticated requests on a public tunnel, and says so in one
   banner line you have to be looking for. Put secrets in `.env`: node reads it from
   **disk** at startup, so no shell inheritance can lose it.

24. **`tmux new -d -s x '<command>'` deletes the session — and the error — when the
   command exits.** You get a missing session from `tmux ls` and no message at all.
   Start a shell first and `send-keys` the command into it, so the shell outlives the
   process and holds the error.

25. **A tmux pane runs a *login* shell, so it resolves nvm's `default` alias, not the
   version you selected with `nvm use`.** `node -v` in your own terminal is therefore
   not evidence about what the bridge will get. Check with `bash -lic 'node -v'` and fix
   with `nvm alias default 22`.

28. **The two halves are joined by one field nobody documents: the webhook's callback
   URL.** It is the tunnel URL plus `/api/messages`, and it is the only thing connecting
   Teams to the bridge. Two things are worth knowing about it. It is **editable at any
   time** - so a webhook can be created with a placeholder before the tunnel exists, and
   repointed later, which is what happened repeatedly during development while VS Code
   port forwarding churned the URL on every restart. And a *named* tunnel keeps a stable
   URL, which is the entire reason this field is set once rather than every session.
   Get the current value with `devtunnel show teams-bridge` (add `-j` for JSON).

   The bridge itself never inspects `req.url`, so the `/api/messages` path is convention
   rather than a requirement - useful to know when a probe on `/` behaves the same way.

27. **`devtunnel host` with no tunnel id creates a brand new tunnel every time.** The
   CLI says so in one line of its own help - *"Host a tunnel, if tunnel ID is not
   specified a new tunnel will be created"* - and the consequence is severe: `devtunnel
   host -p 3978` looks like the obvious way to start hosting, works perfectly, prints a
   healthy-looking public URL, and that URL is **not the one your Teams webhook points
   at**. Nothing is broken and nothing complains; messages simply never arrive. Always
   name the tunnel: `devtunnel host teams-bridge`.

   Ctrl+C on a *named* host is safe and is the normal way to stop it. It ends the
   hosting process only - the tunnel, its id, its URL and its port configuration are
   account-level and survive, so Teams and Power Automate need no changes. The only
   effect is that the public URL has no host until you start one again, which presents
   as the ~15s hang and empty 200 in section 20.

26. **A broad ignore pattern can silently exclude the template your own setup
   instructions depend on.** `.gitignore` held `.env` and `.env.*`, and the second
   pattern also matched **`.env.example`** — so the template was never committed, and
   `cp .env.example .env` fails on every fresh clone with "No such file or directory".
   Nothing warns you: `git add -A` succeeds, `git status` is clean, and the file is
   present on the machine that wrote the docs. Negate the exception explicitly
   (`!.env.example`, which must come *after* the pattern it exempts) and then verify the
   only way that counts — clone into a temp directory and check the file is there.

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
| R2 | **Security.** HMAC proves the message came from Teams, *not* who sent it. | `aadObjectId` allowlist, on and enforced before anything else (`bridge.js:468`, ahead of the busy check). Append-only JSONL audit of **every** inbound message, accepted or not. Secrets deleted from the agent's spawn environment. Fail-closed: no `aadObjectId` means rejected. |
| R3 | Long threads exhaust the context window | `infiniteSessions: { enabled: true }` from the first line of real code, never retrofitted. |
| R4 | Crash mid-turn = permanent silence after "on it 👍" | Turn timeout (30 min, credited back for time spent waiting on a human) rejects into the same catch that posts `That turn failed: …` to the thread. Failure is always audible. |
| R5 | Tunnel URL churn / dies with the IDE | Named `devtunnel` (`teams-bridge`) under tmux. Stable URL, 1.2s round trip. Later found to be an *account-level* object, so it survives a machine move too (§17). |
| R6 | Can the agent ask a question and wait? | Live run: parked **159.0s**, answer routed correctly, delayed post 5 min later still in-thread. |
| R7 | Flow auto-disabled by governance | Moved to the user's own Power Platform environment. 15/15 soak. |

**Still open:**

| # | Risk | Status |
|---|---|---|
| — | **Prompt injection — residual, not solved** | The allowlist governs who *talks* to the agent, not what it *reads*. With tools auto-approved, a hostile string in a repo file, issue or fetched page can steer it using your credentials. Name it; don't pretend to have fixed it. |
| — | **Branch protection — assumed, never verified** | It is the honest answer to "what stops a poisoned README pushing to `main`", and it is the backstop R2 leans on. It has not actually been checked on the target repo. The startup banner warns when a yolo agent is sitting on `main`/`master`, which is a reminder, not a control. |

R2, R3 and R4 moved from open to closed during the build; the entries above describe
what shipped, not what was planned. Every remaining risk is on our side of the wire —
nothing depends on Teams, Power Automate, or tenant policy any more.

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

## 10. The build list, and how it turned out

This section was written before the SDK was wired in, as a list of what remained. All of
it is now built. Kept as a record, with the outcome against each item, because several
predictions were wrong in instructive ways.

| # | planned | outcome |
|---|---|---|
| 1 | Swap the fake scenario for a Copilot session | done — `openSession()` |
| 2 | Pass `approveAll` explicitly as `onPermissionRequest` | done — and the warning was right, see §11 |
| 3 | Wire `onUserInputRequest` to the parked-question map | done — proven live, §13 |
| 4 | Throttle milestone posts | done |
| 5 | A question timeout and a turn timeout | done — `ANSWER_TIMEOUT_MS`, `TURN_TIMEOUT_MS` |
| 6 | Allowlist, audit log, keep secrets from the agent | done, all three |
| 7 | Tell the agent it is being read on a phone | done — but **not** the way planned |

Two are worth expanding.

**Item 6 was solved better than specified.** The plan said use the CLI's `secret-env-vars`
setting. That setting does not exist in the SDK — grepping for it finds nothing, and it
would be easy to conclude the protection is missing. It is stronger than planned:

```js
const agentEnv = { ...process.env };
delete agentEnv.TEAMS_WEBHOOK_SECRET;
delete agentEnv.TEAMS_FLOW_URL;
const client = new CopilotClient({ env: agentEnv, workingDirectory: REPO_DIR });
```

The secrets are removed from the environment the agent is spawned into. Not filtered out
of its output — absent. A yolo agent with a shell cannot print what it was never given.
Filtering output would have been a filter; this is a wall.

**Item 7 was planned as one line in `AGENTS.md`. That was the wrong home for it.** An
`AGENTS.md` lives in the *target* repo, and the bridge is meant to point at any repo
(§14) — so the instruction would have to be copied into every repo, and forgotten in
most. It also would not apply if the repo already had its own `AGENTS.md` conventions.

The right hook is `systemMessage`, which lives on `SessionConfigBase` — the same place as
`model` and `reasoningEffort`, and therefore carried by **both** create and resume:

```js
if (VOICE) config.systemMessage = { mode: "append", content: VOICE };
```

`"append"` keeps every SDK guardrail and adds a section. `"replace"` exists and is
tempting, but its own docs say it "removes all SDK guardrails including security
restrictions" — not a trade worth making for tone of voice. The text lives in
`prompts/teams-voice.md`, so changing how the agent sounds is editing a markdown file
and running `npm run reload`, with no code change and no target repo touched.

### What the voice prompt is worth, measured

Same question to the same model, once without the prompt and once with:
*"Write a JS function that debounces a callback, and show me the code."*

| | characters | lines | code block |
|---|---|---|---|
| without | 1460 | 64 | **yes** |
| with | 694 | 5 | **no** |

The difference is not just length. Without the prompt the agent printed an
implementation into the chat. With it, the agent **wrote the code into the repo, ran the
tests, and described the result in five sentences** — naming the file in words, saying
the suite passed 18 of 18, and offering to commit. That is the actual product: not a
shorter answer, a different shape of answer. One is unusable while driving; the other is
exactly what you want read aloud.

The instructions that earned their place: lead with the outcome not the process; never
paste code or diffs; ask one question at a time with **numbered options**. The last one
matters because the answer path is already proven — in the live run (§13) the reply
`"lets do #1"` mapped straight onto a parked question. Numbered options make the cheapest
possible reply from a car also the correct one.

---

## 11. Yolo mode: what it does and does not cover

The bridge auto-approves every tool by default. A permission prompt nobody can see is
just a hang, and the person driving this is in a car.

**Proven, not assumed.** A task that wrote a test file, ran node's test runner and made
a git commit produced **11 permission requests, all auto-approved, nothing blocked** —
9 tests passing and a commit on disk.

### Not all handlers behave the same when omitted

This matters because omitting `onPermissionRequest` silently hangs the agent, so the
obvious worry is that the other request handlers hide the same trap. They do not, and
the reason is a one-word difference in the docs:

| Handler | Omitted behaviour | Blocks? |
|---|---|---|
| `onPermissionRequest` | *"surfaced as events and **left pending**"* | **yes** — must provide |
| `onElicitationRequest` | *"**when provided**, enables …"* | no — capability stays off |
| `onExitPlanModeRequest` | *"**when provided**, enables …"* | no |
| `onAutoModeSwitchRequest` | *"**when provided**, enables …"* | no |
| `onUserInputRequest` | *"**when provided**, enables the ask_user tool"* | no — but we want it |

So leaving elicitation, exit-plan-mode and auto-mode-switch unset is the **correct**
yolo-safe posture, not an oversight: the agent never issues those requests, so they can
never stall the pipe. Providing them would *enable* dialogs we cannot render in a Teams
thread. This is written down mainly so nobody later "fixes" the omission and breaks it.

### Yolo is not the same as silencing the agent

Two different things travel under the same word:

- **Permission prompts** — *"may I edit this file?"* Noise on a phone. Auto-approved.
- **Design questions** — *"which of these three approaches do you want?"* The entire
  point of the product. Kept.

Turning off `onUserInputRequest` would technically be "more yolo" and would gut the
thing we built.

### Enterprise policy can cap it, silently

`session.managed_settings_resolved` carries `bypassPermissionsDisabled`. When set,
enterprise policy restricts bypass-permissions mode, and the symptom is the agent
stalling on its first tool call for no visible reason. The bridge logs the flag at
session start and logs `session.managed_settings_enforced` if policy ever blocks
something. Nothing was capped in this tenant.

### The audit trail

Every permission variant carries a human-readable `intention`, and shell requests carry
the exact command — much more reviewable than a tool name:

```json
{"kind":"permission","decision":"approve","permissionKind":"shell",
 "intention":"Show latest commit","detail":"git --no-pager log --oneline -1"}
```

With auto-approval on, this log is the only record of what the agent did on your behalf.

## 12. Model and reasoning effort: pin them

The bridge originally set no model, so it took the runtime default. Two things were
true and neither was visible:

1. The default resolved to **`claude-opus-5`** — the same model as the Copilot CLI
   session that built this project. Pleasant accident: the north-star ("talk to it
   from Teams the way I talk to it at my desk") was literally the same model.
2. That default ran at **`reasoningEffort: "medium"`**, because `defaultReasoningEffort`
   for the model is `medium`. Every run described in this document — including the
   106-second parked question and the agent catching its own `999.6ms` bug — happened
   at *medium* effort. Nobody chose that; it was just the floor.

Both are now pinned: `COPILOT_MODEL` defaults to `claude-opus-5`, `COPILOT_EFFORT`
defaults to `xhigh`. A runtime default that drifts under a demo is not a risk worth
carrying for free.

**The SDK's type is stale.** `ReasoningEffort` in the typings is
`"low" | "medium" | "high" | "xhigh"`, but the runtime reports:

```
supportedReasoningEfforts: ["low","medium","high","xhigh","max"]
defaultReasoningEffort   : "medium"
```

So `max` exists and the type does not list it. The docs say to trust the runtime
("Use `client.listModels()` to check supported values"), and the bridge is plain JS,
so `COPILOT_EFFORT=max` is reachable. Only `xhigh` has been verified end to end here.
This is the seventh time on this project that documentation or typings disagreed with
what the system actually does.

**The asymmetry that would have bitten us.** Both `SessionConfig` and
`ResumeSessionConfig` extend `SessionConfigBase`, which is where `model` and
`reasoningEffort` live. Since a Teams thread *resumes* on every turn after the first,
setting these only on create would have given every conversation one good turn and
then a silent drop back to the default. `openSession()` builds one config object and
uses it on both paths, so this is structurally safe — but it is safe by accident, and
worth not "tidying up".

**Verified, not assumed:** there is no public `getReasoningEffort()` on `Session`, so
confirmation came from running a real turn and reading the session journal:

```
$ grep -oE '"(model|reasoningEffort)":"[^"]*"' ~/.copilot/session-state/<id>/events.jsonl
"model":"claude-opus-5"
"reasoningEffort":"xhigh"
```

Effort is recorded, not silently discarded.

## 13. The full loop, proven live

2026-07-27. First real Teams message to the SDK-backed bridge. This is the run that
closes the project's central question — not "can messages cross the gap" (proven
earlier with a scripted harness) but "can a real agent do real work through it".

```
+387.6s from       : arajawat (1a2b3c4d-…)
+387.6s text       : "Look at util.js and add input validation to every exported
                      function. Ask me first how strict you should be…"
+387.6s threadRoot : 1785136979855
+387.6s ROUTED AS NEW PROMPT
+387.7s no session to resume (Session not found), creating teams-1785136979855
+393.2s auto-approved: read  — Search for files matching pattern
+394.5s flow POST -> 202 in 1341ms
+395.4s auto-approved: read  — Read file: util.js
+401.4s auto-approved: shell — List repo files and show package.json
+403.8s auto-approved: read  — Read file: util.test.js
+409.2s ASKING: "How strict should the validation on `add` be?…"
+410.3s flow POST -> 202 in 1182ms
──────────────────────────────────────────────────────────────
+457.6s from       : arajawat (1a2b3c4d-…)
+457.6s text       : "lets do #1"
+457.6s ROUTED AS ANSWER
+457.6s ANSWER after 48.5s
+463.4s auto-approved: write — Edit file
+468.4s auto-approved: write — Edit file
+475.8s auto-approved: shell — Run node test suite
+479.4s turn complete in 91.7s
```

Everything that had only been proven in isolation worked together: HMAC on a real
payload, thread-root derivation, session creation, seven yolo auto-approvals with
nothing blocked, a question parked for **48.5 seconds** of human thinking time, and
the answer routed back into the *same* session rather than starting a new one.

The detail worth keeping: the reply was **"lets do #1"**. Nobody types option text on
a phone. The bridge maps a bare numeral onto the corresponding choice, and that
mapping is what makes the interaction survive contact with a car.

### The allowlist is now on

The live message revealed the real `aadObjectId`, which is the only trustworthy source
for it — HMAC proves a message came from Teams, never who typed it.

One hardening applied first. `aadObjectId` is a GUID and its casing is not guaranteed,
so the comparison now lowercases both sides. Without that, a casing change would lock
you out of your own bridge behind a message that explains nothing — this project's
signature failure mode. Verified across four cases:

| sender | outcome |
|---|---|
| exact-case allowed id | routed |
| **UPPERCASE** same id | routed (reached the busy check, which sits *after* the allowlist) |
| unknown id | rejected |
| **no `aadObjectId` at all** | rejected — fail-closed, not fail-open |

The last row matters most: an absent id must never be treated as permission.

## 14. Pointing the bridge at any repo

Settings that are not secrets now live in `bridge.config.json`; `npm run reload` makes
them active. Two constraints shaped this more than convenience did.

**Secrets stay out of the file.** `TEAMS_WEBHOOK_SECRET` and `TEAMS_FLOW_URL` remain in
the bridge shell's environment. A config file gets copied, backed up, and screen-shared
during a demo; a shell's environment does not. So `reload.sh` restarts the bridge
*inside its existing tmux window* rather than starting a new shell — the secrets never
have to be handled again. Nothing is lost by restarting, because Copilot sessions live
on disk and resume by an id derived from the Teams thread.

**Validate before killing anything.** `reload.sh` checks the config and the target repo
first and refuses to reload if either is broken, so a typo cannot leave you with no
bridge at all.

### The git identity landmine

The agent had been committing happily in the scratch repo, which hid this: the **global**
git identity on this machine is empty. The scratch repo had a *local* identity
(`t <t@t>`), set long ago and forgotten. Point the bridge at a freshly cloned repo and
the agent's first `git commit` fails with "Please tell me who you are" — several minutes
into a turn, from a car, with the failure buried in tool output.

`checkRepo()` now resolves `git config user.name/user.email` (which falls through local
→ global → system) at startup and prints the fix. Same for: not a directory, not a git
repo, no `origin` remote, and sitting on `main` or `master` with yolo enabled.

This is the same lesson as everything else in this document — **the failure would not
have been loud.** It would have looked like the agent quietly deciding not to commit.

### Verified

Six config paths: real repo; missing `repoDir`; a directory that is not a git repo; a
git repo with no identity; malformed JSON (throws, rather than silently falling back to
defaults and pointing the agent at the wrong repo); and env-overrides-file.

Then a full turn against a **brand new empty repo** driven entirely by the config file —
agent created `hello.js`, committed it, and the committed code runs. Reload was also
exercised against the live bridge: the allowlist came from the config file rather than
the launch line, while HMAC and the flow URL survived in the tmux shell.

### Still one repo at a time

Turns are globally serialised because there is one working directory — a second thread
gets "I'm busy". Repo-per-thread (`WORK_ROOT/<threadRoot>`) would remove the lock and
let threads run in parallel. That is the natural v2, and deliberately not built yet.

## 15. Old threads: proven, and still nothing stored

The design bet was that a Teams thread from days ago should resume mid-conversation
without the bridge keeping any records. The session id is a pure function of the thread
root, so there is nothing to look up and nothing to go stale:

```js
const sessionId = "teams-" + conversation.id.split(";messageid=")[1];
```

Tested rather than assumed. A session was given two facts to hold, its files were
backdated three days, and it was resumed **in a fresh process**:

```
RESUMED OK (3-day-old session, fresh process)
RECALL: Codeword: **TANGERINE-47**. Casing: **snake_case**.
```

Both facts came back exactly. Supporting evidence for longer gaps: 190 session
directories on this machine, the oldest six weeks old and still intact, with no
retention, TTL, or cleanup setting anywhere in `~/.copilot`. Session state is not
reaped behind your back.

Worth being clear about what this does *not* prove. If session state is ever deleted,
`resumeSession` throws `Session not found`, and the bridge falls back to creating a
session with the same derived id. The thread keeps working; it just starts fresh. That
is the right failure — a lost conversation, never an error message the user in a car
has to interpret.

## 16. Shipping this to other people

Worth saying plainly first: **the tunnel and the Power Automate flow are scaffolding,
not architecture.** They exist because app sideloading is blocked in this tenant, which
killed the Azure Bot path on day one. Every awkward part of this system traces back to
that single constraint. Read the ladder below with that in mind — most of it is not
work, it is one unblock.

### Stage 0 — today: one person, one machine

Works, end to end, proven. One developer, one laptop, one tunnel, one repo, one thread
at a time. Good enough to demo and genuinely useful for the person who set it up.

### Stage 1 — your immediate team

Reachable, but three things get uncomfortable:

| problem | why it bites |
|---|---|
| **The agent uses one GitHub token** | Whoever types, the work is done *as the person who started the bridge*. The allowlist limits who can drive; it cannot make them act as themselves. |
| **The flow posts as you** | Power Automate replies come from the account that owns the flow, so the agent appears to be you talking to yourself. |
| **One turn at a time** | A single working directory means a second thread gets "I'm busy". |

The third is the only one that is genuinely cheap to fix: repo-per-thread
(`WORK_ROOT/<threadRoot>`) removes the lock and lets threads run in parallel. The first
two are not fixable at this layer.

### Stage 2 — the actual product: bring back the Azure Bot

This is the whole answer, and it is worth being blunt that it collapses nearly every
workaround in this document at once:

| workaround today | with a bot |
|---|---|
| devtunnel, which dies silently | a real HTTPS endpoint |
| Power Automate for outbound | proactive messages, native |
| the 5-second webhook window | gone — plus typing indicators |
| **@mention on every single message** | gone in 1:1 chat |
| flow posts as you | the bot posts as itself |
| no per-user identity | real user identity on every activity |

None of that is research. It is blocked by a policy toggle, not by a technical problem.
If this project gets one thing funded, it should be that.

### Stage 3 — hosting

Move off the laptop to a container with a persistent volume for `~/.copilot/session-state`
(or a real store). Note this is *only* about durability: §15 showed session state already
survives restarts and days, so nothing about the design changes — it just stops depending
on one machine staying awake.

### Stage 4 — identity, which is the real unlock

Each user authorises their own GitHub access, and the agent acts as *them*. Until this
exists, "ship it to other users" is not honest — you are handing people a shell that
commits under someone else's name. This is the line between a demo and a product.

### What to say in the pitch

The demo is not "an AI wrote some code". It is:

> I asked for something from my phone. It asked me a clarifying question. I answered
> forty-eight seconds later with "lets do #1". It finished the work and told me when it
> was done — and if I reply to that thread on Thursday, it still knows what we decided.

That is a *conversation*, not a command. Everything in this document exists to protect
that one property.

## 17. Portability: what is actually machine-bound

Asked what it takes to move this to another devbox, the assumption was that the
tunnel URL would change and the Teams outgoing webhook would have to be repointed —
the one step that lives in a UI and cannot be scripted.

That turns out to be wrong, and pleasantly so. **A dev tunnel is an account-level
object, not a machine-level one:**

```
Tunnel ID : teams-bridge.asse
Ports     : 3978  https://<your-tunnel>.devtunnels.ms/
Expiration: 30 days
```

`~/bin/devtunnel host teams-bridge` from any machine signed into the same account serves
that same URL. So Teams, the webhook secret, and the Power Automate flow are all
untouched by a move. Thread ids are unchanged too, so derived session ids still line up.

What genuinely has to be redone on a new box:

| step | note |
|---|---|
| node ≥ 22.12, `npm install` | SDK 1.0.8 requires `^20.19.0 \|\| >=22.12.0` |
| Copilot auth | `copilot login`, **or headless** via `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` |
| `gh auth login` | for push and PR creation |
| **global git identity** | the §14 landmine — set it globally on a fresh box |
| devtunnel install + `~/bin/devtunnel user login` | `libicu-dev` needed on Ubuntu — **not** a pinned `libicu<NN>`, see landmine 18. Call it by full path, see landmine 19 |
| `bridge.config.json` | gitignored, recreate from the example |
| the two secrets | exported into the bridge shell |

Headless auth matters more than it looks: a devbox has no browser, and `copilot login`
defaults to a device flow. `GH_TOKEN=$(gh auth token)` sidesteps it. Fine-grained PATs
need the **Copilot Requests** permission; classic `ghp_` tokens are rejected outright.

Conversation history is portable but optional — copy `~/.copilot/session-state/teams-*`
to bring threads along, or skip it and let them start fresh (§15). `COPILOT_HOME`
relocates that directory, which is the hook for putting session state on a mounted
volume when this eventually moves into a container (§16, stage 3).

**The real expiry risk:** dev tunnels are deleted after **30 days of inactivity** — a
sliding window rather than a countdown from creation, so ordinary use keeps a tunnel
alive indefinitely. The exposure is a long pause, not a long life. If one does lapse,
the URL changes and the Teams webhook has to be updated by hand. That, not the machine
move, is the thing to watch — and it is why the recommended way to pause this system is
to stop the *bridge* and leave the tunnel hosted.

### Two corrections to the above

The first draft of this runbook had two holes, both caught on review.

**1. There is nothing to clone.** This repo has no remote — it exists only on the
machine it was written on. "Move to another devbox" quietly assumed a step that does
not exist yet. Worth stating plainly because it is a bus-factor problem, not just a
portability one: 16 commits of findings live in exactly one place.

```sh
gh repo create code-from-teams --private --source=. --remote=origin --push
```

**2. Two tmux sessions, not one.** The runbook showed only the bridge. The tunnel needs
its own session because `devtunnel host` exits with its terminal (landmine 11), and a
dead tunnel is the single worst failure mode in this system: Teams times out and blames
the webhook, while the bridge log stays completely empty. Anything that makes it easier
to forget the tunnel is a real hazard, including a runbook that does not mention it.

```sh
tmux new -s tunnel     # devtunnel host teams-bridge
tmux new -s bridge     # node scripts/bridge.js
```

## 18. Stopping and starting, measured

"How do I pause this for a while?" has a right answer and a wrong one, and they are not
obvious from the outside. Measured against the live system:

| stopped | what a Teams message gets | tunnel |
|---|---|---|
| **bridge only** | `502` in **0.8s** | still hosted, `Host connections: 1` |
| tunnel | ~15s hang, then an empty `200` | gone |

**Stop the bridge, leave the tunnel hosted.** Two reasons, both concrete:

1. **The error is honest and fast.** 502 in 0.8s lands well inside the 5-second webhook
   window, so Teams says something went wrong immediately. The tunnel-down case blows
   through the window with an empty 200, which Teams reports as a webhook failure — the
   single most confusing failure mode in this system, and the one where the bridge log
   is empty because nothing ever reached it.
2. **It protects the URL.** Dev tunnels expire after 30 days of *inactivity* (a sliding
   window). A hosted tunnel is the reason that clock never starts. Lose the tunnel and
   you get a new URL, which means editing the Teams webhook by hand — the one piece of
   this setup that cannot be scripted.

Nothing else needs care: sessions are on disk and resume by derived id, so a pause of
any length loses no conversation.

### Detaching from tmux without killing anything

Worth writing down because it cost real time. `Ctrl+B d` is bound correctly
(`bind-key -T prefix d detach-client`); it reads as a chord but is a **sequence** —
press `Ctrl+B`, release both, *then* `d`. Holding them together is why it looks broken.

The better habit is not to attach at all:

```sh
tmux capture-pane -p -t bridge | tail -30
```

Attaching puts a live agent process one keystroke away from `Ctrl+C`. Reading the pane
has no such failure mode, and it is what was used throughout this project.

## 19. Auditing before you publish

Pushing this to GitHub meant checking it did not carry secrets. Three things were worth
learning.

**Audit the history, not the working tree.** `git log -p` across every commit, not a
scan of the current files. A secret deleted in a later commit is still sitting in the
history, fully readable, and a clean working tree says nothing about that.

**Know what a false positive looks like.** The scan flagged two long base64 strings that
looked exactly like leaked keys. They were npm `sha512-` integrity hashes from the lock
file. Anything that greps for high-entropy strings will find these; recognising them
immediately is the difference between a five-minute check and an afternoon.

**Not-a-credential is not the same as fine-to-publish.** Nothing in the repo could be
used to authenticate as anyone, but two things still deserved redacting:

| what | why it mattered |
|---|---|
| the live tunnel URL | not a secret, but a working address pointing at a yolo agent — an invitation to probe |
| a real `aadObjectId` hardcoded in `fakemsg.js` | a colleague's directory identifier, published without asking them |

Both were replaced with placeholders. Neither would have failed a secret scanner.

**What is still true:** the pre-redaction commits remain in the history, so both values
are recoverable by anyone who can read the repo. That is an accepted risk *because the
repo is private*. Making it public would need a history rewrite first — and that is
exactly the decision that is easy to forget six months later, which is why it is written
down here rather than left as a good intention.

## 20. One tunnel, one host — measured

The tunnel being an account-level object (§17) is what makes moving machines easy. It
also creates the one genuinely dangerous move in this system, and it was worth testing
rather than assuming.

**Test:** with the tunnel healthily hosted from machine A, start a second host against
the same tunnel.

**Result:** the second host connects and reports `Ready to accept connections`. The
first is evicted:

```
ClientSSH: PortForwardingService connection to localhost:3978 failed: Connection refused
Connection to host tunnel relay closed. Another host for the tunnel has connected.
```

Then, killing the second host does **not** return the tunnel to the first. The public
URL times out completely — `000`, no response at all after 20s.

Every signal you would normally trust is wrong at once:

| what you would check | what it says | truth |
|---|---|---|
| `tmux ls` | session alive | serving nothing |
| `ps` | process running | disconnected from the relay |
| `devtunnel show` | `Host connections: 1` | 1, but not *your* host |
| the pane log | the eviction line, once, then silence | the only honest signal, and only if you look |

`Host connections: 1` is the trap. It looks like confirmation. It stays 1 whether you
are the host or someone else is.

### The rule

**Only one machine hosts at a time.** Moving boxes means stopping the old host *before*
starting the new one — and "let me just host it on the new machine to check it works" is
an outage on the old machine, not a test. Recovery is to kill and restart the tunnel's
tmux session; the evicted process will sit there looking healthy forever otherwise.

### Three failure signatures, all different

Worth holding together, because they point at different causes:

| symptom | cause |
|---|---|
| fast `502` (~0.8s) | tunnel up, bridge down — the honest one |
| ~15s hang, empty `200` | no host at all |
| ~20s timeout, `000` | host evicted by another machine |

The middle one is the confusing one in normal operation. The last one only happens when
two machines are involved, which is exactly when you are least likely to suspect the
tunnel.

## 21. Signing in from WSL, where both auth paths fail

Setting up a second machine, `devtunnel user login` hung with **no output whatsoever**
and never returned. Both of the CLI's sign-in methods fail on a Cloud PC in a managed
tenant, and they fail for unrelated reasons — so the obvious escape from the first lands
you in the second.

### Browser auth (the default) hangs silently

`devtunnel user login` defaults to `-b, --use-browser-auth`. Run with `-v`, MSAL says:

```
MSAL: Using system browser.
MSAL: [DefaultOsBrowser] Authorization URI with form_post: https://login.microsoftonline.com/...
```

It calls `xdg-open` and waits for a redirect to `localhost:41443`. **`xdg-open` exists on
WSL but has no browser handler behind it, so it exits `0` having done nothing.** The
success code is the whole problem: nothing in the chain reports an error, so the CLI sits
waiting for a callback that no one will ever make. Zero output, forever.

### Device code fails at the tenant

The obvious next move is `-d`. It gets further — a code appears, sign-in succeeds — and
then Entra refuses:

> Your sign-in was successful but does not meet the criteria to access this resource.

That is Conditional Access. The device-code flow is commonly blocked outright in a
managed tenant, and no amount of retrying changes it. **This path is a dead end, not a
slow path.**

### The fix: repair `xdg-open`, don't route around it

```sh
cat > ~/bin/xdg-open <<'SH'
#!/usr/bin/env bash
exec powershell.exe -NoProfile -Command "Start-Process '$1'"
SH
chmod +x ~/bin/xdg-open
export PATH="$HOME/bin:$PATH"        # must come before /usr/bin/xdg-open
~/bin/devtunnel user login -b -e
```

WSL interop hands the URL to a Windows browser; WSL2 forwards `localhost`, so MSAL's
redirect arrives normally. Installing `wslu` (which provides `wslview` and registers it
as a handler) achieves the same thing.

This is the better fix because it repairs the mechanism rather than the symptom.
Anything else on the box that shells out to `xdg-open` now works too. The alternative
considered and discarded was scraping the authorization URL out of `-v` log output and
opening it manually — it works, but it depends on MSAL's log format and fixes exactly
one command.

### A sharp edge worth knowing

**Starting a device-code login logs you out of the session you already had, even if you
abort it.** The stored credential is cleared when the flow *starts*, not when it
succeeds. Observed directly: `devtunnel user show` reported a valid login, two
device-code attempts were started and abandoned, and `user show` then reported
`Not logged in`.

A running `devtunnel host` keeps serving throughout, because its relay connection is
already established and is not re-authenticated. So the machine looks completely healthy
and the breakage only surfaces the next time the tunnel is restarted — possibly days
later, with no obvious connection to what caused it. Check `devtunnel user show` after
any interrupted login.

---

## 22. tmux does not give you the environment you think it does

Two separate failures on the second machine had the same root cause, and both were
silent.

### What is actually true

**A tmux session inherits the environment of whatever shell started the tmux *server*,
not the shell that typed `tmux new`.** The server is started by the *first* session and
outlives every session created after it.

Measured directly:

```sh
tmux kill-server
MARKER=first  tmux new -d -s s1 'sleep 30'     # this starts the SERVER
MARKER=second tmux new -d -s s2 'sleep 30'     # created from a different env
tmux new -d -s s3 'echo "MARKER=$MARKER" > /tmp/out; sleep 5'   # no MARKER at all
cat /tmp/out
```

`MARKER=first`. The third session was created from a shell where `MARKER` was **not
set**, and it received the value from a shell that had exited minutes earlier.
`update-environment` only refreshes a short fixed list (`DISPLAY`, `SSH_AUTH_SOCK` and
friends) — `PATH` and your own variables are not on it.

### Consequence 1: exported secrets never arrive

```sh
export TEAMS_WEBHOOK_SECRET=...      # in your normal shell
tmux new -d -s bridge ...            # server already running -> does NOT see it
```

The bridge starts with `HMAC OFF` and `outbound flow NOT SET`. It does not crash, does
not warn beyond one banner line, and **accepts unauthenticated requests** — on a public
anonymous tunnel, with yolo on. The failure is a security hole that looks like a
successful start.

`.env` is immune, because node reads it off **disk** at process start, not from the
environment. Verified: server started first, `.env` written afterwards, secret still
arrived. This is now the recommended path, and the reason is this finding rather than
convenience.

The export route still works, but only if typed **inside the bridge pane** before
launching the process.

### Consequence 2: the wrong node

The bridge died instantly on the second machine because the pane had node 20; the SDK
needs >= 22.12. The subtlety is that this is **not** the server-environment rule — a
tmux pane runs a *login* shell, which re-sources the profile, which loads nvm, which
resolves nvm's **`default` alias**. So the pane gets nvm's default, which is often not
the version you last selected interactively with `nvm use`.

That is why `node -v` in your own terminal is not evidence. The predictive check is:

```sh
bash -lic 'node -v'          # what a tmux pane will actually resolve
nvm alias default 22         # the fix - persistent, unlike `nvm use`
```

Confirmed by poisoning the server's `PATH` to `/usr/bin:/bin` and observing panes still
find nvm's node: the login shell repairs `PATH` regardless of what the server holds.

### Consequence 3: a failed command deletes its own evidence

```sh
tmux new -d -s bridge 'cd /repo && npm run bridge'
```

If the command exits, **tmux destroys the session**, and the error with it. `tmux ls`
then simply omits the session — no message, no exit code, nothing to read. This is how
the node 20 failure presented: two commands typed, one session listed, zero output.

Start a shell first and send the command to it. The shell survives the process, so the
error stays on screen and `tmux capture-pane -p -t bridge` retrieves it without
attaching:

```sh
tmux new -d -s bridge
tmux send-keys -t bridge 'cd /repo && npm run bridge' Enter
```

### The general lesson

All three are the same shape as landmines 18-21: **a setup step that works on the
machine that wrote it is not a verified step.** The environment differences between two
boxes are invisible until a second box runs the instructions, and every one of these
surfaced as silence rather than an error.
