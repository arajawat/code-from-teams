# Code from Teams

Drive GitHub Copilot from a Microsoft Teams thread — so you can direct real coding work
while driving, making coffee, or otherwise away from a keyboard.

The goal is conversational fidelity, not task submission:

> "the way I am talking to you right now, I should be able to talk in the same way
> from Teams."

The agent can ask you a question mid-task and wait for your answer, exactly as it does
in a terminal.

**Core abstraction:** `1 Teams thread = 1 Copilot session`

**Status:** working end to end against real Teams. One live run: acked inside the
5-second window, auto-approved 7 tools, asked a question with options, **parked 48
seconds** while the user was away, took `"lets do #1"` as the answer rather than a new
prompt, and finished in 91 seconds. Reply to that thread days later and it still knows
what you decided. See [docs/FINDINGS.md](docs/FINDINGS.md).

---

## How it works

```
Teams channel thread
      │  @mention  →  outgoing webhook  (HMAC signed, must answer within 5s)
      ▼
Bridge (node, :3978, exposed via tunnel)
      │  verify HMAC → allowlist → derive sessionId → ack inside 5s
      ▼
Copilot SDK session  (cwd = your repo, resumed by caller-supplied id)
      │  milestones, questions, final result
      ▼
Power Automate flow  →  "Reply with a message in a channel"  →  SAME thread
```

Inbound and outbound use **different mechanisms**, because a Teams outgoing webhook can
only reply inside a 5-second HTTP response window. Anything later — a milestone, a
question, the final result — goes back through a Power Automate flow.

The session id is *derived*, never stored:

```js
const sessionId = "teams-" + conversation.id.split(";messageid=")[1];
```

The `;messageid=` suffix is the thread root and is stable for every message in a thread.
That is the whole persistence design: no database, no mapping table, nothing to go stale.

---

## Documentation

- **[docs/FINDINGS.md](docs/FINDINGS.md)** — what worked, what failed, and what we
  deliberately didn't try because a better option existed. Read this first.
- **[docs/DESIGN.md](docs/DESIGN.md)** — the running design log with full rationale.

---

## One-time setup

Three cloud-side pieces. You do these once; they survive machine moves.

### 1. Teams outgoing webhook (inbound)

Team owner → **Manage team** → **Apps** → *Create an outgoing webhook* (bottom of page).
Point the callback URL at your tunnel (step 2). Save the security token — that is
`TEAMS_WEBHOOK_SECRET`.

> Mentions must be picked from the **autocomplete dropdown**. Typing `@name` as plain
> text does not fire the webhook.
>
> **Every message needs the @mention, including replies.** A bare "yes" never reaches
> the bridge, so any question the agent asks has to remind you.

### 2. Tunnel

The bridge listens on `:3978` and needs a public HTTPS URL.

```sh
curl -sL https://aka.ms/DevTunnelCliInstall | bash   # lands at ~/bin/devtunnel
chmod +x ~/bin/devtunnel                             # the installer's sudo step fails
sudo apt install -y libicu78                         # required; it's a .NET binary

devtunnel user login
devtunnel create teams-bridge -a                     # -a = anonymous; Teams needs it
devtunnel port create teams-bridge -p 3978
```

The name makes the URL stable, so the webhook callback is set once. The tunnel belongs
to your **account, not your machine** — see [Another machine](#another-machine).

> Tunnels carry a **30-day expiration**. If one lapses you get a new URL and must update
> the webhook by hand. Re-hosting periodically avoids it.

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

The trigger's **HTTP POST URL** is `TEAMS_FLOW_URL`.

> If the flow auto-disables within a minute or two, that's a DLP policy in the Default
> environment. Export it as a package and import into an environment with a looser
> policy — DLP is evaluated **per environment**.

---

## Running it

```sh
npm install                                          # needs node >= 22.12

tmux new -d -s tunnel '~/bin/devtunnel host teams-bridge'
tmux new -d -s bridge 'cd ~/workspace/code-from-teams && npm run bridge'
```

**Both sessions are required.** `devtunnel host` exits with its terminal, and a dead
tunnel does not fail loudly: the public URL still resolves, hangs ~15s and returns an
empty 200, so Teams times out at 5s and blames the webhook while the bridge logs
nothing. **If the bridge log is empty, the problem is never in the bridge.**

### The two secrets

`TEAMS_WEBHOOK_SECRET` and `TEAMS_FLOW_URL` are both bearer secrets — the flow URL's
`sig=` parameter *is* its auth. Either put them in `.env` (gitignored):

```sh
cp .env.example .env && $EDITOR .env
```

…or keep them off disk entirely, exported in the bridge shell only:

```sh
read -rs TEAMS_WEBHOOK_SECRET && export TEAMS_WEBHOOK_SECRET
read -rs TEAMS_FLOW_URL       && export TEAMS_FLOW_URL
```

### Watching and checking

```sh
tmux attach -t bridge       # Ctrl+B, release, then D to detach

curl -s -m 15 -o /dev/null -w '%{http_code} in %{time_total}s\n' \
  -X POST https://<your-tunnel>/api/messages -d '{}'
```

A fast response means healthy — the probe is unsigned, so rejecting it is correct.
~15s and an empty body means the tunnel is down.

> WSL can shut down when the last terminal closes, killing tmux with it. Keep one
> terminal open, or `sudo loginctl enable-linger $USER`.

---

## Configuration

Non-secret settings live in `bridge.config.json`:

```sh
cp bridge.config.example.json bridge.config.json && $EDITOR bridge.config.json
npm run reload
```

```json
{
  "repoDir": "~/work/my-service",
  "model": "claude-opus-5",
  "effort": "xhigh",
  "yolo": true,
  "allowedAadIds": ["1a2b3c4d-…"]
}
```

`npm run reload` validates everything **before** touching the running bridge, then
restarts it inside its existing tmux window — so the secrets never leave that shell.
Nothing is lost: sessions live on disk and resume by their derived id, so conversations
survive a reload.

Secrets are deliberately **not** allowed in this file. Environment variables override
anything set here, for one-off runs.

`allowedAadIds` is the only real authorisation control. Send one message and the bridge
logs the sender's `aadObjectId`; put that in the list.

### What the target repo needs

The startup banner checks these and complains loudly if any is missing:

| requirement | why |
|---|---|
| exists, and is a git repo | worth catching before a turn starts, not during one |
| **a git identity** | `git commit` fails without one, and the *global* identity is often unset |
| an `origin` remote | needed to push or open PRs |
| not sitting on `main` | a yolo agent with commit rights on `main` is a bad afternoon |

An `AGENTS.md` in that repo is the cheapest way to fix the tone, because the agent is
being read aloud on a phone:

```md
Replies are read on a phone, often in a car. Keep them under three sentences.
Never paste diffs or file contents — push a branch and link the PR instead.
When you need a decision, ask one question with numbered options.
```

---

## Another machine

The dev tunnel is an **account-level object**, so `devtunnel host teams-bridge` from any
box signed into the same account serves the *same URL*. Nothing in Teams or Power
Automate changes, and thread ids still derive to the same session ids.

So a move is only: `npm install` (node >= 22.12), `devtunnel user login`, your
[configuration](#configuration) and [secrets](#the-two-secrets), and a **global** git
identity on the new box (`git config --global user.name / user.email`) — that missing
identity is the classic trap, surfacing as a failed commit minutes into a turn rather
than at startup.

Thread memory lives in `~/.copilot/session-state/teams-*`. Copy it to bring
conversations along; skip it and threads degrade gracefully to fresh ones.
`COPILOT_HOME` relocates that directory if you want state on a mounted volume.

---

## Scripts

| Script | Purpose |
|---|---|
| `npm run bridge` | The bridge itself. |
| `npm run reload` | Apply `bridge.config.json` to the running bridge. |
| `npm run msg -- "text"` | Send a signed fake Teams message locally. `--thread <id>` to pick a thread. |
| `npm run mockflow` | Stand in for the Power Automate flow, so the whole loop runs offline. |
| `npm run harness` | The original scripted round-trip: ack → question → answer → delayed post. |
| `npm run post -- <threadRoot> "hi"` | Post one message into a thread via the flow. |
| `npm run soak -- <threadRoot> 60 15` | Post on an interval to catch a silently suspended flow. |

`msg` + `mockflow` together exercise the full path with zero Teams messages.
`scripts/teams-webhook-test.js` is a bare inbound receiver, useful when you only want
to see what Teams actually posts.

---

## Security

The bridge runs an agent with tools auto-approved, on a machine holding real GitHub
credentials, driven by a chat channel.

- **HMAC proves the request came from Teams. It does not prove who sent it.** The
  `aadObjectId` allowlist is the only authorisation control, and it is fail-closed —
  a message with no `aadObjectId` is rejected.
- The agent's environment has both Teams secrets **removed at spawn time** — it has a
  shell, so anything left in `process.env` is one `env` away from the channel.
- Audit log of every permission, with the agent's own stated intention, in
  `audit.jsonl`. With auto-approval on, this is the only record of what it did.
- Branch protection as a server-side backstop. An `AGENTS.md` line saying "never push
  to main" is a suggestion, not a boundary.

**Residual and unsolved: prompt injection.** The allowlist governs who *talks* to the
agent, not what it *reads*. A hostile string in a repo file, issue or fetched page can
steer it using your credentials — and yolo mode removes the prompt that would have
caught it.
