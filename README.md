# Code from Teams

Drive GitHub Copilot from a Microsoft Teams thread — so you can direct real coding work
while driving, making coffee, or otherwise away from a keyboard.

The goal is conversational fidelity, not task submission:

> "the way I am talking to you right now, I should be able to talk in the same way
> from Teams."

The agent can ask you a question mid-task and wait for your answer, exactly as it does
in a terminal.

**Core abstraction:** `1 Teams thread = 1 Copilot session = 1 branch`

---

## How it works

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

Inbound and outbound use **different mechanisms**, because a Teams outgoing webhook can
only reply inside a 5-second HTTP response window. Anything later — a milestone, the
final result, a question — goes back through a Power Automate flow.

The session id is *derived*, never stored:

```js
const sessionId = "teams-" + conversation.id.split(";messageid=")[1];
```

The `;messageid=` suffix is the thread root and is stable for every message in a thread.

---

## Documentation

- **[docs/FINDINGS.md](docs/FINDINGS.md)** — what we tried, what worked, what failed,
  and what we deliberately didn't try because a better option existed. Read this first.
- **[docs/DESIGN.md](docs/DESIGN.md)** — the running design log with full rationale.

---

## Setup

### 1. Teams outgoing webhook (inbound)

Team owner → **Manage team** → **Apps** → *Create an outgoing webhook* (bottom of page).
Set the callback URL to your tunnel. Save the security token.

> Mentions must be selected from the **autocomplete dropdown**. Typing `@name` as plain
> text does not fire the webhook.

### 2. Tunnel

The bridge listens on `:3978` and needs a public HTTPS URL. VS Code's Ports panel works
— **set the visibility to Public**, it defaults to Private and fails silently.

`devtunnel` gives a stable URL if re-editing the callback URL each restart grates.

### 3. Power Automate flow (outbound)

Teams → **Workflows** → template **"Send webhook alerts to channel"**.

> The trigger `When a Teams webhook request is received` is **invisible in both trigger
> pickers**. The template installs it anyway. Do not use `When an HTTP request is
> received` — that one is a premium connector.

Then edit the flow and replace `Post card in a chat or channel` with:

| Field | Value |
|---|---|
| Action | **Reply with a message in a channel** |
| Team / Channel | hardcoded |
| Message Id | `triggerBody()?['threadRoot']` |
| Message | `triggerBody()?['text']` |

If the flow gets auto-disabled within a minute or two, that's a DLP policy in the
Default environment. Export the flow as a package and import it into an environment with
a looser policy — DLP is evaluated **per environment**.

---

## Scripts

Copy `.env.example` to `.env` and fill in both secrets, then every script picks them
up automatically:

```sh
cp .env.example .env
$EDITOR .env
npm run bridge
```

`.env` is gitignored. Both values are bearer secrets — the flow URL's `sig=` parameter
*is* its auth.

Prefer not to keep them on disk? Export them per shell instead:

```sh
read -rs TEAMS_WEBHOOK_SECRET && export TEAMS_WEBHOOK_SECRET
read -rs TEAMS_FLOW_URL       && export TEAMS_FLOW_URL
```

## Keeping it running

Both the bridge **and** the tunnel must stay up. A stopped tunnel does not fail fast —
the public URL still resolves, hangs ~15s and returns an empty 200, so Teams times out
at 5s and blames the webhook while the bridge logs nothing.

```sh
tmux new -d -s tunnel '~/bin/devtunnel host teams-bridge'
tmux new -d -s bridge 'cd ~/workspace/code-from-teams && npm run bridge'

tmux ls                     # what's running
tmux attach -t bridge       # watch logs; Ctrl+B release, then D to detach
```

WSL can shut down when the last terminal closes, killing tmux with it. Keep one
terminal open on WSL, or `sudo loginctl enable-linger $USER`.

Health check:

```sh
curl -s -m 15 -o /dev/null -w '%{http_code} in %{time_total}s\n' \
  -X POST https://<your-tunnel>/api/messages \
  -H 'Content-Type: application/json' -d '{"type":"message","text":"probe"}'
```

Fast response + `signature check failed` means everything is healthy (the probe is
unsigned, so rejecting it is correct). ~15s and an empty body means the tunnel is down.

| Script | Purpose |
|---|---|
| `scripts/teams-webhook-test.js` | Minimal inbound receiver. Prints the parsed payload, thread root and derived session id. |
| `scripts/teams-roundtrip-test.js` | Full scenario: instant ack → question with options → answer routing → delayed post 5 minutes later. |
| `scripts/postflow.js` | Post one message into a thread via the flow. |
| `scripts/soakflow.js` | Post on an interval to detect a flow being silently suspended. |

```sh
node scripts/teams-roundtrip-test.js                    # full scenario
node scripts/postflow.js <threadRoot> "hello"           # single post
node scripts/soakflow.js <threadRoot> 60 15             # every 60s for 15 min
```

`teams-roundtrip-test.js` honours `PORT`, `QUESTION_DELAY_MS`, `DELAYED_REPLY_MS` and
`ANSWER_TIMEOUT_MS` for faster iteration.

---

## Security

The bridge runs an agent with tools auto-approved, on a machine holding real GitHub
credentials, driven by a chat channel.

- **HMAC proves the request came from Teams. It does not prove who sent it.** The
  `aadObjectId` allowlist is the only authorisation control.
- Private team of one.
- Audit log of **every** message, not just rejected ones — after an incident the
  question is "what did it run", not just "who knocked".
- Branch protection as a server-side backstop. An `AGENTS.md` line saying "never push to
  main" is a suggestion, not a boundary.
- Both `TEAMS_WEBHOOK_SECRET` and `TEAMS_FLOW_URL` are bearer secrets. The flow URL's
  `sig=` parameter *is* its auth. Register them as `secret-env-vars` so the agent's
  shell tools can't echo them into a Teams thread.

**Residual and unsolved: prompt injection.** The allowlist governs who *talks* to the
agent, not what it *reads*. A hostile string in a repo file, issue or fetched page can
steer it using your credentials.
