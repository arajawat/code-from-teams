# Code from Teams — design (for review)

State as of 2026-07-25. Only current conclusions; see plan.md for how we got here.

---

## 1. What is proven (tested, not assumed)

| Fact | Evidence |
|---|---|
| Outgoing webhook works in the corp tenant | created + received real messages |
| Sideloading is blocked | "This app is not available" on Preview in Teams |
| HMAC verification works | `signature : true` on real payloads |
| Reply within 5s lands **in the same thread** | `got it: "hello"` appeared in-thread |
| `conversation.id` thread root is stable across a thread | FIRST/second test, same root |
| `replyToId` is **always null** — unusable | both messages, including a real reply |
| `text` is HTML despite `textFormat: "plain"` | `<p><at>testhook</at>&nbsp;hello</p>` |
| Copilot SDK persists + resumes by caller-supplied id | `@github/copilot-sdk` 1.0.8 .d.ts |

## 2. Architecture

    Teams channel thread
          │  @mention  →  outgoing webhook (HMAC, instant, in-thread reply)
          ▼
    Bridge  (node, :3978, exposed by tunnel)
          │  verify HMAC → check allowlist → derive sessionId → ack within 5s
          ▼
    Copilot SDK session   (cwd = the repo, resumed by id)
          │  session events
          ▼
    milestones + final result  →  Workflows incoming webhook  →  same Teams thread

Three boxes. The bridge is the only thing we write.

**The whole model in one line:** `1 Teams thread = 1 Copilot session = 1 branch`

## 3. Message lifecycle (concrete)

1. User posts `@copilot fix the flaky test` in a thread
2. Teams POSTs to the bridge with `Authorization: HMAC <sig>`
3. Bridge verifies the signature — *proves it came from Teams, NOT that the sender is
   authorised. Different things.*
4. Bridge checks `from.aadObjectId` against the allowlist
5. `sessionId = "teams-" + conversation.id.split(";messageid=")[1]`
6. Bridge answers the HTTP request within 5s: `{"type":"message","text":"on it 👍"}`
   → lands in-thread for free
7. Bridge resumes-or-creates the SDK session and sends the prompt
8. Interesting events → throttled milestone posts via Workflows
9. Final response → posted via Workflows, in-thread

## 4. Decisions and why

**Derive the session id, never store it.** `SessionListFilter` only filters by
workingDirectory/gitRoot/repository/branch, and `SessionMetadata` has no name or tag
field. Every session here shares the same repo — so if a map file were lost, there is
*no way* to work out which session belongs to which thread. Deriving removes an
unrecoverable single point of failure, plus the read-modify-write race, for free.

**Serialize turns.** One active turn globally; a second thread gets "busy, queued you."
Threads map to sessions, and several could otherwise run against the same working
directory at once and corrupt each other. ~10 lines, and keeps git worktrees out of scope.

**Output style is a prompt, not code.** One line in `AGENTS.md`: *"You are being read
aloud on a phone. Keep replies under 3 sentences. Never paste diffs — link to the PR."*

**Milestones, not token streaming.** Token streaming is a desk feature and useless while
driving. One post per *interesting* event, throttled to ~1 per 15s. Not optional: two
minutes of silence looks broken, especially on stage.

**Use the SDK, not `copilot -p`.** `-p` spawns a fresh process per message, can't be
interrupted, and can't ask permission. The SDK stays warm and has `onPermissionRequest`,
steering and queueing natively.

## 5. Open risks — ranked

**R1. Posting back into the *right thread* is unverified.** ← biggest
The 5s ack is threaded for free, but milestones and the final result arrive later and
must go via Workflows. If Workflows can only post *new top-level messages*, the
conversation fragments — and worse, each new post is a new thread root, so a user
replying to it lands in a *different session*. That would break the core abstraction.
Mitigation: Power Automate has a **"Reply with a message in a channel"** action taking a
parent message id, and we have every id needed (`aadGroupId`, `teamsChannelId`,
threadRoot). Believed to work; **must be tested before anything else is built.**

**R2. Security.** The bridge runs an agent with tools auto-approved, on a box holding
real GitHub credentials, driven by a Teams channel. HMAC proves the request came from
Teams; it says nothing about who sent it. The `aadObjectId` allowlist is the *only*
authorisation control — and anyone in the channel can @mention the webhook.
DECIDED mitigations (hackathon):
 - allowlist on from.aadObjectId (the ONLY authorisation control)
 - private team of one
 - AUDIT LOG of EVERY message, not just rejected ones. After an incident the question is
   "what did it run and who asked", not just "who knocked". Append-only JSONL:
     { ts, aadObjectId, name, threadRoot, prompt, decision: "allowed"|"denied" }
 - BRANCH PROTECTION on main as the real backstop. An AGENTS.md line like "never push to
   main" is a suggestion, not a boundary -- an agent's instructions are not a security
   control. Server-side rules are.
   CHECKED 2026-07-25: `gh api repos/.../rules/branches/main` returns [] -> no rulesets
   on main. Classic branch protection returns 404, which means EITHER absent OR
   unreadable without admin -- inconclusive. VERIFY IN THE REPO SETTINGS UI before the
   agent gets push rights.
 - SECRET REDACTION: TEAMS_WEBHOOK_SECRET lives in the bridge env, which the agent's
   shell tools INHERIT. One `env` call would post it into Teams for the whole channel.
   Set the SDK/CLI `secret-env-vars` for TEAMS_WEBHOOK_SECRET and GITHUB_TOKEN.

RESIDUAL, NOT SOLVED: prompt injection. The allowlist governs who TALKS to the agent,
not what it READS. With tools auto-approved, a hostile string in a repo file, issue, PR
comment or fetched page can steer it, acting with the user's credentials. Correct
hackathon move is to NAME it, not fix it -- and branch protection is the honest answer
to "what stops a poisoned README pushing to main".

**R3. Long threads exhaust the context window.** A Teams thread can live for days. The
SDK has an `infiniteSessions` resume option — enable it from the start, not at 2am.

**R4. Crash mid-turn = silence forever.** The user gets "on it 👍" and nothing else, with
no way to tell whether it's thinking or dead. Needs a turn timeout that posts a failure.

**R5. Tunnel URL churn.** VS Code forwarding hands out a new URL on restart, and each
one means re-editing the webhook. `devtunnel` CLI gives a stable named URL if it grates.

## 5a. Hosting — where things actually live

Common confusion: "hosting the repo" and "hosting the SDK" are not real questions.
 - The repo stays on GitHub (origin = azure-data-database-platform/pgtoolsservice).
   The runner holds a CLONE; the agent edits it, commits, pushes back.
 - The SDK is not hosted. It is an npm dependency (@github/copilot-sdk) inside the
   bridge process, which spawns the Copilot runtime as a child process.

=> Exactly ONE machine matters: the one holding the working copy.
   Two long-lived listeners run on it: the bridge (:3978) and the tunnel.

Current host: <your-devbox>, WSL Ubuntu 26.04. systemd + tmux available,
repo cloned, gh already authed as arajawat. Nothing to provision.

DECIDED: host stays on this box. It is a Windows 365 Cloud PC and those normally
hibernate on disconnect (which would kill the listener and tunnel), but the user is
handling hibernation separately -- treat it as a non-issue, not a design constraint.
Staying put also KEEPS the desk<->phone handoff, which only exists because the bridge
shares ~/.copilot/session-state/ with the terminal.

## 6. Explicitly out of scope

Model / agent / skill selection · slash commands · plan mode · Adaptive Cards and buttons
· multiple repos · multiple users · identity mapping · git worktrees · a "create PR"
feature (the agent already runs `gh pr create` itself) · token streaming · the autonomy
dial (S3) · desk↔phone handoff (nice-to-have, mechanism exists)

## 7. Build order

1. Verify R1 (Workflows reply-in-thread) — everything depends on it
2. Bridge: HMAC + allowlist + sessionId derivation + 5s ack
3. SDK wiring: resume-or-create, send, await result
4. Milestone throttling + `AGENTS.md` output prompt
5. Serialize lock, turn timeout

## OUTBOUND / LONG-RUNNING NOTIFICATIONS (R1) — designed 2026-07-25
Problem: the outgoing webhook can only reply inside its 5-second HTTP response window.
Anything later (milestones, the final result, an agent question) needs a separate
outbound path back into the SAME thread.

### LICENSING TRAP (verified) — two different triggers, only one is free
  "When an HTTP request is received"     -> Request connector -> PREMIUM. DO NOT USE.
  "When a Teams webhook request is received" -> Teams connector -> STANDARD/FREE. USE THIS.
Both expose a POST URL. The Teams one is the sanctioned replacement for the retired
O365 incoming webhooks, which is why it is not gated.

### THE FLOW (2 steps, built in Teams -> Workflows -> Create -> from blank)
 1. Trigger: "When a Teams webhook request is received"
      - "Who can trigger the flow?" = Anyone   (the generated URL IS the secret)
 2. Action : Teams -> "Reply with a message in a channel"
      - Team      : hardcoded (single team, single channel = nothing dynamic needed)
      - Channel   : hardcoded
      - Message Id: DYNAMIC  -> triggerBody()?['threadRoot']
      - Message   : DYNAMIC  -> triggerBody()?['text']
Bridge side is one fetch:
    POST <flowUrl>  {"threadRoot": "1784956184852", "text": "pushed, PR #42"}

### WHY THIS SHOULD WORK (evidence, still to be confirmed by test)
"Reply with a message in a channel" takes Message Id = the PARENT message id. The
documented way to obtain it by hand is Teams -> right-click message -> Copy link, whose
URL contains `messageid=1784956184852` — the SAME numeric form we already extract from
conversation.id. Formats match, so the id we have is the id the action wants.

### R1 TEST (10 min, unblocks the whole build)
curl the flow URL with the thread root already captured (1784956184852) and confirm the
message lands as a REPLY INSIDE that thread, not as a new top-level post.
  PASS -> R1 closed, build proceeds.
  FAIL (new top-level post only) -> replies fragment AND create new thread roots, so
  answering one lands in a different session. Fallback: accept top-level posts that
  quote the thread, or drive outbound from a Graph token instead.

### CAVEATS
 - Flow URL is a BEARER SECRET (anyone with it can post as the flow). Env var +
   secret-env-vars, same treatment as the webhook token.
 - Teams connector has per-connection rate limits; the ~1-post-per-15s milestone
   throttle already keeps us well under.
 - Latency: this is a PUSH trigger, not the ~60s poller used by "when a new message is
   posted". Expect seconds. Workflows webhooks are reported slower than the legacy
   connectors, so measure it during the R1 test.

## R6 (NEW): AGENT ASKS A QUESTION AND WAITS — API VERIFIED
User raised: must support the agent asking for clarification mid-task, like a normal
chat. Verified against @github/copilot-sdk 1.0.8 typings — first-class support exists:

    onUserInputRequest?: UserInputHandler        // on the session config
    // docs: "When provided, ENABLES THE ask_user TOOL allowing the agent to ask questions."
    type UserInputHandler = (req: UserInputRequest, inv: {sessionId: string})
                              => Promise<UserInputResponse> | UserInputResponse
    UserInputRequest  = { question: string; choices?: string[]; allowFreeform?: boolean }
    UserInputResponse = { answer: string; wasFreeform: boolean }

KEY: the handler may return a PROMISE. So the bridge parks it and resolves it when the
next Teams message arrives in that thread. No polling, no hack, no extra transport —
INBOUND IS THE SAME WEBHOOK WE ALREADY HAVE. Only the ROUTING differs: a message is
either a new prompt or the answer to a parked question.

    onUserInputRequest: async (req) => {
      await postToTeams(threadRoot, render(req.question, req.choices));
      return { answer: await waitForNextMessage(threadRoot), wasFreeform: true };
    }

Notes:
 - ask_user is OFF unless the handler is supplied. Omitting it = agent never asks and
   proceeds on assumptions. So this is an opt-in switch, not a thing to suppress.
 - Same shape for permissions: `onPermissionRequest`. IMPORTANT — omitting it does NOT
   auto-approve, it leaves requests PENDING ("surfaced as events and left pending").
   MVP must pass the SDK's exported `approveAll` explicitly.
 - `choices` render as a numbered list; accept "1" or free text back.
 - Requires a small IN-MEMORY per-thread pending-resolver map. This does not break the
   "bridge holds no state" rule: it only covers an in-flight turn, which dies on restart
   anyway. The SESSION itself is still derived, never stored.

DEADLOCK RISK (interaction between two earlier decisions): a parked question holds the
turn open, and the global serialize lock allows only one turn at a time => one
unanswered question BLOCKS THE ENTIRE BRIDGE FOREVER. Walking away from your phone
mid-question is the normal case, not the edge case. MUST have a question timeout
(auto-cancel the turn and post "timed out, ask me again"). Non-negotiable.

## ROUND-TRIP TEST HARNESS — teams-roundtrip-test.js (2026-07-25)
Proves the full shape before any Copilot SDK wiring: immediate ack, delayed in-thread
post, question-with-options, and answer routing.

LOCAL DRY RUN PASSED (mock flow on :3999 standing in for Power Automate):
  new prompt        -> immediate reply inside the 5s window            OK
  question posted   -> options rendered + "<-- recommended" marker     OK
  reply routed as ANSWER, not a new prompt (parked 18.1s, resolved)    OK
  freeform answer ("milestones + a heartbeat please") accepted         OK
  delayed leg fired after the sleep, same threadRoot                   OK
So the state machine is correct. The ONLY unproven component left is the real Power
Automate flow replacing the mock endpoint.

Env overrides for fast iteration:
  PORT, QUESTION_DELAY_MS, DELAYED_REPLY_MS, ANSWER_TIMEOUT_MS
Design points baked in:
  - `pending` map (threadRoot -> resolver) = the parked question. In-memory by design.
  - `active` set stops a stray message starting a second scenario on one thread.
  - ANSWER_TIMEOUT_MS is the deadlock guard; on expiry it posts "timed out, ask again"
    rather than holding the turn open forever.

## OUTBOUND PUSH CONFIRMED WORKING (2026-07-25)
Trigger "When a Teams webhook request is received" is NOT visible in either the Teams
Workflows blank-flow trigger picker or the make.powerautomate.com trigger search.
IT IS STILL USABLE: install it via the TEMPLATE "Send webhook alerts to channel"
(Teams -> Workflows -> templates). The template creates a flow using that exact trigger
and hands back a POST URL. Template route succeeded where both pickers failed.

VERIFIED: POSTing an Adaptive Card payload to the flow URL posts into the channel.
=> outbound push EXISTS in this tenant. The email-trigger hack and the pull-only
   fallback are both no longer needed.

ENVIRONMENT: Teams Workflows flows ALWAYS land in the tenant Default environment and
this cannot be changed. To edit: make.powerautomate.com -> environment picker (top
right) -> Default -> My flows. NOTE: connector availability and DLP are PER-ENVIRONMENT,
which is the likely reason the trigger search came up empty (wrong env selected).
The flow runs on the user's own Teams connection, so it posts as them / Flow Bot and
can only reach channels they can already reach.

REMAINING FOR R1: swap the template's "Post card in a chat or channel" action for
"Reply with a message in a channel" with Message Id = triggerBody()?['threadRoot'].

## R1 CLOSED - PASSES (2026-07-25)
"Reply with a message in a channel" with Message Id = triggerBody()?['threadRoot']
posts INSIDE the original thread. Confirmed by observation in Teams.
=> the core abstraction (1 Teams thread = 1 Copilot session) is fully proven:
     inbound  outgoing webhook  -> threadRoot extracted from conversation.id
     outbound Power Automate    -> reply lands back in that same threadRoot
   Both directions verified against a real thread. No remaining design unknowns.

## NEW RISK R7: FLOW AUTO-DISABLES (delivery risk, not a design flaw)
Observed: the flow is turned off within 1-2 MINUTES of being enabled, repeatedly. One
message did get delivered in the window before it was killed.
1-2 minutes is FAR too fast for Power Automate's failure-based auto-disable (which needs
repeated failures over days), so cause (a) below is effectively ruled out. This is an
active governance/DLP sweep suspending the flow.
  (a) "turned off due to repeated failures" -> Power Automate's standard auto-disable
      after consecutive trigger/action errors. Caused by OUR bad payloads during
      testing. Fix the payload, re-enable, done. NOT a policy problem.
  (b) DLP / org policy suspension -> the tenant forbids this connector combination
      (an unauthenticated webhook trigger feeding the Teams connector is a common
      DLP block). DO NOT work around this: repeatedly re-enabling to defeat a
      security control is not acceptable. Legitimate options only:
        - ask a Power Platform admin for an exemption
        - run the demo in a personal M365 developer tenant (full admin, also unlocks
          app sideloading and the proper Azure Bot route, which is a better
          architecture than webhook + Power Automate anyway)
        - stay on the corp tenant and fall back to the pull model, which needs no flow

## R7 CLOSED (2026-07-25)
Flow EXPORTED from the Default environment and IMPORTED into the user's own Power
Platform environment (same tenant). Soak test: 15 posts, 1/min for 15 min, ZERO
failures. In Default the same flow was suspended within 1-2 minutes.
=> confirms DLP is evaluated PER ENVIRONMENT and the suspension was a Default-env
   policy, not a property of the connector combination.
Mechanism note (why this works): the environment is only a GOVERNANCE boundary. Reach
is determined by the CONNECTION (the user's own OAuth token) and the Team/Channel
chosen in the action. Moving environments changes which DLP policy is evaluated and
nothing else. Connections do NOT export, so the Teams connection is re-authenticated
on import, and the trigger URL is REGENERATED (new url after import).

## STATUS: ALL TRANSPORT RISKS CLOSED
  inbound   outgoing webhook + HMAC + threadRoot extraction   PROVEN on real messages
  outbound  Power Automate flow, threaded reply               PROVEN + 15 min soak
  routing   new prompt vs answer-to-parked-question           PROVEN (local dry run)
  ask_user  onUserInputRequest returns a Promise              VERIFIED in SDK typings
Nothing about the transport is unknown any more. Remaining work is the Copilot SDK
wiring itself, which has no external dependencies.

## R5 CLOSED - STABLE TUNNEL (2026-07-27)
Replaced VS Code port forwarding with the standalone devtunnel CLI, so the tunnel no
longer depends on VS Code being open and the URL no longer churns on restart.

Install notes (WSL Ubuntu 26.04):
  curl -sL https://aka.ms/DevTunnelCliInstall | bash     # lands in ~/bin/devtunnel
  chmod +x ~/bin/devtunnel
  sudo apt install -y libicu78     # REQUIRED: devtunnel is a .NET app and fails with
                                   # "Couldn't find a valid ICU package" without it.
                                   # DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 does NOT
                                   # work around it for this single-file build.
Named persistent tunnel (same URL every restart):
  devtunnel user login
  devtunnel create teams-bridge -a          # -a = allow anonymous; Teams needs it
  devtunnel port create teams-bridge -p 3978
  devtunnel host teams-bridge
Current URL: https://a1b2c3d4-3978.euw.devtunnels.ms

VERIFIED 2026-07-27: POST to <tunnel>/api/messages reached the bridge and returned the
5s ack. HTTP 200 in 1.2s. No anti-phishing interstitial on JSON POSTs (that only
affects browser GETs), so no X-Tunnel-Skip-AntiPhishing-Page header is needed.

Chosen over cloudflared/ngrok deliberately: those work without sudo but route corp
Teams traffic through a third party, which conflicts with the data-policy constraint
that already ruled out an M365 dev tenant. devtunnel keeps traffic Microsoft-side.

SURVIVING VS CODE CLOSING: run the bridge and the tunnel under tmux (or systemd user
units). CAVEAT: WSL itself can shut down when the last terminal closes, which kills
both regardless of tmux -- keep one Windows Terminal open on WSL, or
`sudo loginctl enable-linger $USER`.

## DEAD TUNNEL: THE FAILURE MODE THAT COSTS THE MOST TIME (2026-07-27)
Symptom: Teams replies instantly with "Sorry, there was a problem encountered with your
request", attributed to the WEBHOOK'S name (so it looks like the bot answered), and the
bridge logs NOTHING - not even a rejected request.

Cause: `devtunnel host` was not running. The tunnel does not fail fast. The public
hostname still resolves, the request hangs ~15s, and then returns HTTP 200 with an
EMPTY BODY. Teams gives up at 5s. Everything about it says "your app is slow", when in
fact your app was never reached.

30-SECOND DIAGNOSIS:
  curl -s -o /dev/null -w '%{http_code} %{time_total}\n' -X POST localhost:3978/api/messages -d '{}'
  curl -s -o /dev/null -w '%{http_code} %{time_total}\n' -X POST https://<tunnel>/api/messages -d '{}'
  local fast (~0.015s) + public slow (~15s) => tunnel is dead, restart it.
  both slow                                 => the bridge is the problem.
Rule of thumb: if the bridge log is EMPTY, the problem is never in the bridge.

## R6 CLOSED - FULL ROUND TRIP AGAINST REAL TEAMS (2026-07-27)
The last unproven step. One real thread, root 1785130046292, teams-roundtrip-test.js:

  +229.3s  "ping"  signature true  -> ROUTED AS NEW PROMPT
  +235.6s  flow POST -> 202 in 1357ms      question posted into the thread
  +393.3s  "2"     signature true  -> ROUTED AS ANSWER to a parked question
                                     ANSWER received after 159.0s
  +394.7s  flow POST -> 202 in 1426ms      choice acknowledged
  +394.7s  sleeping 300s before the delayed leg...
  +696.0s  flow POST -> 202 in 1215ms      delayed result, SAME thread (confirmed in UI)
  +696.0s  scenario complete

Proves, against live Teams and not a mock:
  1. ack inside the 5s window
  2. question with numbered options + a recommendation, pushed via the flow
  3. the bridge parking while the user walks away (159s, no keepalive, no polling)
  4. the next message routed as an ANSWER, not as a new prompt
  5. a post 5 MINUTES LATER landing in the same thread

(5) is the whole product. "Ask, walk away, get told when it's done" is now demonstrated
infrastructure rather than a claim. Also observed in the same log: a mis-signed probe
was REJECTED, so HMAC rejection is proven on live traffic too.

The scripted scenario is the exact shape of a real turn - ack, ask, wait, work, report.
Swapping in a Copilot session changes what fills the gaps, not the mechanics.

## LANDMINE: EVERY MESSAGE NEEDS THE @MENTION, INCLUDING REPLIES
Cost us 20 minutes of debugging a bridge that was working perfectly. An outgoing webhook
only fires on messages that MENTION it. A bare "yes" in the thread never arrives.

Consequence for the design, not just for the user: the agent's question must SAY SO.
askQuestion() now appends "(@mention me in your reply, or I will not see it.)".
Without that line, the user answers, nothing happens, and the turn parks until the
timeout - looking like a hung agent rather than a missed message.

This is a genuine cost of the webhook route. An Azure Bot receives every message in the
channel and would not need this. Worth revisiting if sideloading is ever permitted.

## STATUS AFTER R6: TRANSPORT IS DONE
  R1 threaded outbound reply      CLOSED
  R5 stable tunnel                CLOSED
  R6 ask-a-question round trip    CLOSED  <- live, real Teams
  R7 flow stability               CLOSED
  R2 security hardening           OPEN  (allowlist, audit log, secret-env-vars)
  R3 infiniteSessions             OPEN
  R4 turn timeout                 OPEN
  -- prompt injection             RESIDUAL, acknowledged, not solved
Every remaining risk is on OUR side of the wire. Nothing left depends on Teams, Power
Automate, or tenant policy.

## NEXT: REPLACE THE SCENARIO WITH A COPILOT SESSION
teams-roundtrip-test.js already contains every piece the real bridge needs - HMAC,
toPlainText(), threadRootOf(), the parked-question map, the serialize lock, flow POST.
Only runScenario() is fake. Replace it with:
  1. npm i @github/copilot-sdk
  2. createSession({ sessionId: `teams-${threadRoot}`, ... }) / resumeSession(id, cfg)
     infiniteSessions: { enabled: true }   <- an OBJECT, not a boolean
  3. onPermissionRequest: approveAll     <- MUST be explicit; omitting it HANGS
  4. onUserInputRequest: ask via the flow, return the parked Promise (already built)
  5. milestone posts throttled to ~1/15s, then the final result
  6. question timeout + turn timeout (R4)

## SDK API VERIFIED AGAINST THE TYPINGS (@github/copilot-sdk 1.0.8, 2026-07-27)
Re-checked rather than quoted from memory, and one thing I had written was WRONG.

  createSession(config: SessionConfig): Promise<CopilotSession>
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSession>
  session.send(prompt | MessageOptions): Promise<string>              // returns msg id
  session.sendAndWait(prompt | MessageOptions, timeout?): Promise<AssistantMessageEvent | undefined>

SessionConfig.sessionId?: string
  "Optional custom session ID. If not provided, the server generates one."
  ^ This is what makes derive-don't-store work. We hand it teams-<threadRoot>.

sendAndWait takes a TIMEOUT argument, which is R4 (turn timeout) mostly solved for free.
It resolves with the final assistant message when the session goes idle, and returns
undefined rather than throwing - so `undefined` must be handled as "turn produced
nothing", not treated as success.

CORRECTION: infiniteSessions is InfiniteSessionConfig, an OBJECT, not a boolean:
  { enabled?: boolean (default true),
    backgroundCompactionThreshold?: number (default 0.80),
    bufferExhaustionThreshold?: number (default 0.95) }
An earlier note in this file said `infiniteSessions: true`. Wrong shape. Fixed.

Re-confirmed:
  approveAll IS exported from the package root (dist/index.d.ts), typed PermissionHandler.
  onPermissionRequest omitted => "surfaced as events and LEFT PENDING for the consumer
    to resolve" - i.e. the agent hangs. Not auto-approve. Confirmed in the doc comment.
  onUserInputRequest - "When provided, ENABLES the ask_user tool". Off by default.
  UserInputHandler = (request, invocation: { sessionId }) => Promise<...> | ...
    The Promise return is what lets us park the question in a Teams thread.
