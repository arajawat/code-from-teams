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
what you decided. Replies are shaped for a phone, not a terminal — it writes code into
the repo and tells you what changed, rather than pasting a diff at you.
See [docs/FINDINGS.md](docs/FINDINGS.md).

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
      │  pinned model + effort + voice prompt, on both create and resume
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
sudo apt install -y libicu-dev                        # required; it's a .NET binary
```

**On WSL, install a browser shim before logging in.** Sign-in opens a browser, which
WSL cannot do, so the login hangs forever printing nothing at all:

```sh
cat > ~/bin/xdg-open <<'EOF'
#!/usr/bin/env bash
exec powershell.exe -NoProfile -Command "Start-Process '$1'"
EOF
chmod +x ~/bin/xdg-open
export PATH="$HOME/bin:$PATH"                        # shim must beat /usr/bin/xdg-open
```

`wslu` (which provides `wslview`) does the same job if you'd rather install a package.

```sh
~/bin/devtunnel user login -b -e                     # browser + Entra; see below
```

Then, **once per account — not once per machine**:

```sh
~/bin/devtunnel create teams-bridge -a               # -a = anonymous; Teams needs it
~/bin/devtunnel port create teams-bridge -p 3978
```

> **On a second machine, skip both `create` commands.** The tunnel is an account-level
> object, so it already exists and already has its port. Running `create` again gives
> you:
>
> ```
> Tunnel service error: Conflict with existing entity. Retry tunnel operation.
> ```
>
> which is the tunnel saying *"I already exist"* — so it is really confirmation you are
> on the right account. **Ignore the "Retry" advice; retrying can never succeed.** Go
> straight to `~/bin/devtunnel host teams-bridge`.

> **Always name the tunnel when hosting.** `devtunnel host` with *no* id silently
> creates a **new** tunnel — the CLI's own help says "if tunnel ID is not specified a
> new tunnel will be created". So `devtunnel host -p 3978` starts fine, prints a
> healthy public URL, and that URL is not the one your Teams webhook points at.
> Messages then simply never arrive, with nothing anywhere reporting a problem.
>
> **Ctrl+C on `devtunnel host teams-bridge` is safe** and is the normal way to stop it.
> It ends the hosting process only — the tunnel, its URL and its port survive, because
> they belong to your account. The public URL just has no host until you start one
> again (which looks like the ~15s hang and empty 200 above). Run it under tmux so it
> also survives closing the terminal.

> **Don't reach for `-d` (device code) when the browser hangs.** It is the obvious next
> move and it fails differently: sign-in succeeds, then Conditional Access rejects it
> with *"your sign-in was successful but does not meet the criteria to access this
> resource"*. In a managed tenant the device-code flow is commonly blocked outright.
> Browser auth with the shim is the path that works — fix the browser, don't route
> around it.
>
> **Worse, starting a device-code login logs you out of the one you already had**, even
> if you abort it — the stored credential is cleared up front, not on success. A
> running `devtunnel host` keeps serving because its relay connection is already
> established, so nothing appears wrong until the next restart fails to authenticate.

> **Call it by full path.** Ubuntu's `~/.profile` only adds `~/bin` to `PATH` if that
> directory **already existed when you logged in** — and the installer creates it
> mid-session, so a bare `devtunnel` gives `command not found` until you log out and
> back in. Full paths sidestep it entirely, which is why every command here uses one.
> To get the short name now: `export PATH="$HOME/bin:$PATH"`.

The name makes the URL stable, so the webhook callback is set once. The tunnel belongs
to your **account, not your machine** — see [Another machine](#another-machine).

> Tunnels are deleted after **30 days of inactivity** — a sliding window, so ordinary
> use keeps yours alive indefinitely. If one does lapse you get a new URL and must
> update the webhook by hand. See [Pausing and restarting](#pausing-and-restarting).

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

Five steps, in order — and the order matters. The bridge reads `.env` from **disk**,
once, at startup. Start it before the secrets exist and it comes up with HMAC
verification OFF and no outbound URL, and stays that way until you restart it.

### 1. Dependencies

Check the node version **the way tmux will see it**, not the way your current shell
does. A tmux pane runs a login shell, so it resolves nvm's `default` alias — often not
whatever you last ran `nvm use` on.

```sh
bash -lic 'node -v'                     # must be >= 22.12
nvm install 22 && nvm alias default 22  # only if it is not
npm install
```

### 2. The two secrets

Neither is something you invent — **both are issued to you**, one by Teams and one by
Power Automate, and you copy them out.

| | `TEAMS_WEBHOOK_SECRET` | `TEAMS_FLOW_URL` |
|---|---|---|
| issued by | Teams, when you create the outgoing webhook (setup step 1) | Power Automate, when you save the flow (setup step 3) |
| where | shown **once**, on creation | the trigger card's **HTTP POST URL**, readable any time |
| what it is | a base64 key | a URL whose `sig=` query parameter *is* the auth |
| used for | Teams signs each request `Authorization: HMAC <base64>`; the bridge recomputes HMAC-SHA256 over the raw body and compares in constant time | the bridge POSTs to it to get a message back into the thread |
| if lost | regenerate it on the webhook in **Manage team → Apps** | re-open the flow trigger and copy it again |

**Both are bearer secrets.** Anyone holding the flow URL can post into your channel as
the flow; anyone holding the webhook secret can forge inbound requests. Treat the URL
with the same care as the key — the fact that it looks like a link is exactly why people
leak it.

Missing either one is not a crash, it is a **quiet downgrade**:

| unset | what happens |
|---|---|
| `TEAMS_WEBHOOK_SECRET` | HMAC verification off — the bridge accepts **unauthenticated** requests. On a public anonymous tunnel with yolo on, anyone who finds the URL runs code on your box |
| `TEAMS_FLOW_URL` | the bridge works but every reply silently no-ops — you send messages into a void |

So put them in `.env`, which is gitignored:

```sh
cp .env.example .env && $EDITOR .env
```

`.env.example` documents all 23 settings, but only these two need a value.

> **Do not instead `export` them and then run `tmux new`.** A tmux session inherits the
> environment of whatever shell started the tmux **server**, which may be hours old —
> not the shell you just typed in. Verified: a session created from a shell with a
> variable set received a *different, older* value. `.env` is read from disk by node and
> is immune to this. See [FINDINGS §22](docs/FINDINGS.md).
>
> If you genuinely want them off disk, type them **inside the bridge pane** before
> launching: `tmux attach -t bridge`, then `read -rs TEAMS_WEBHOOK_SECRET && export
> TEAMS_WEBHOOK_SECRET` (and the same for `TEAMS_FLOW_URL`), then `npm run bridge`.

### 3. Settings

Non-secret configuration — which repo the agent works in, model, effort, who is allowed
to drive it. Every field is optional and described inline in the example file; see
[Configuration](#configuration).

```sh
cp bridge.config.example.json bridge.config.json && $EDITOR bridge.config.json
```

### 4. Start both sessions

Start a shell in each session, **then** send the command. Do not use
`tmux new -d -s bridge '<command>'`: if the command exits, tmux deletes the session and
the error goes with it — you get a missing session and no message at all.

```sh
tmux new -d -s tunnel
tmux send-keys -t tunnel '~/bin/devtunnel host teams-bridge' Enter

tmux new -d -s bridge
tmux send-keys -t bridge "cd $PWD && npm run bridge" Enter

tmux ls                                 # BOTH must be listed
```

The trailing **`Enter` is a literal argument**, not an instruction to you — it is tmux's
name for the Return key, telling tmux to submit the command inside the pane. Leave it
off and the text is typed at the prompt and never runs, while `tmux ls` still lists a
perfectly healthy-looking session.

**Both sessions are required.** `devtunnel host` exits with its terminal, and a dead
tunnel does not fail loudly: the public URL still resolves, hangs ~15s and returns an
empty 200, so Teams times out at 5s and blames the webhook while the bridge logs
nothing. **If the bridge log is empty, the problem is never in the bridge.**

### 5. Read the banner

Do not skip this — it is the only place the bridge tells you what it is actually doing.

```sh
tmux capture-pane -p -t bridge
```

Want: **`HMAC ON`** and **`outbound flow SET`**. The banner also prints the repo, model,
effort, voice-prompt path and allowlist, so a bridge running wide open is visible rather
than assumed.

If a session is missing from `tmux ls`, that process died — and with the shell-first
form above, its error is still on screen for `capture-pane` to print.

### Watching and checking

**Read the logs without attaching** — this is the safe default, because you can't
fat-finger the running process:

```sh
tmux capture-pane -p -t bridge | tail -30
```

If you do attach, detaching is **Ctrl+B, release both keys, then `d`** — it is a
sequence, not a chord, and holding them together is why it usually appears not to work.
Stuck attached? From any other terminal:

```sh
tmux detach-client -s bridge
```

> Inside an attached session, **Ctrl+C stops the bridge** and Ctrl+D closes the shell
> and destroys the session. Neither is recoverable by re-attaching.

```sh
curl -s -m 15 -o /dev/null -w '%{http_code} in %{time_total}s\n' \
  -X POST https://<your-tunnel>/api/messages -d '{}'
```

| response | meaning |
|---|---|
| fast `200` | healthy — the probe is unsigned, so rejecting it is correct |
| fast `502` | tunnel up, **bridge down** |
| ~15s, empty body | **tunnel down** — no host at all |
| ~20s, `000` (no response) | **another machine took the tunnel over** — see [§20](docs/FINDINGS.md) |

> WSL can shut down when the last terminal closes, killing tmux with it. Keep one
> terminal open, or `sudo loginctl enable-linger $USER`.

---

## Pausing and restarting

Nothing here is stateful in a way that needs care. Sessions live on disk and resume by
an id derived from the Teams thread, so stopping and starting loses conversations only
if you delete them.

### Pause for a while

**Stop the bridge and leave the tunnel hosted.**

```sh
tmux send-keys -t bridge C-c        # or: tmux kill-session -t bridge
```

Messages sent while paused get a fast `502`, so Teams shows an error immediately rather
than sitting there looking like it might still be working. Un-pause:

```sh
tmux new -d -s bridge
tmux send-keys -t bridge 'cd ~/workspace/code-from-teams && npm run bridge' Enter
```

> **Leave the tunnel up.** Dev tunnels are deleted after **30 days of inactivity** — a
> sliding window, not a countdown from creation — and losing the tunnel means a new URL
> and re-pointing the Teams webhook by hand. Keeping it hosted is the whole reason that
> never happens to you. Stopping the tunnel instead is also strictly worse day to day:
> a dead tunnel hangs ~15s and returns an empty 200, which Teams blames on the webhook.

### After a devbox restart

Everything is gone — tmux, tunnel, bridge — and none of it is a service. The tunnel URL
survives, though, because it belongs to your account, so **Teams and Power Automate need
no changes**.

```sh
tmux new -d -s tunnel
tmux send-keys -t tunnel '~/bin/devtunnel host teams-bridge' Enter
tmux new -d -s bridge
tmux send-keys -t bridge 'cd ~/workspace/code-from-teams && npm run bridge' Enter
tmux ls                             # both must be listed
```

Then, only if your secrets are **not** in `.env`, re-export them in the bridge shell —
that is the one thing a restart genuinely loses. Verify with the health probe above; a
fast `200` means you are done.

To avoid the manual step entirely, `sudo loginctl enable-linger $USER` keeps tmux alive
across WSL shutdowns.

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
  "voiceFile": "prompts/teams-voice.md",
  "allowedAadIds": ["1a2b3c4d-…"]
}
```

Every field is optional. `bridge.config.example.json` carries a description of each one
inline; the short version:

| field | default | what it does |
|---|---|---|
| `repoDir` | the bridge's own directory | the repo the agent works in — point it at a scratch clone. `~` expands. Checked at startup for existence, being a git repo, and a **git identity**, because a missing identity otherwise fails a commit minutes into a turn |
| `model` | runtime default | pinned, because the runtime default drifts as new models ship |
| `effort` | runtime default | `low` \| `medium` \| `high` \| `xhigh`. Also pinned — the default resolved to `medium`, so the agent was quietly thinking less hard than it could |
| `yolo` | `true` | auto-approve every tool call. `false` does **not** prompt you — there is no approval path over Teams — it denies tools outright |
| `voiceFile` | `prompts/teams-voice.md` | appended to the system prompt so replies suit a phone. Missing file = loud banner warning, not a silent revert |
| `allowedAadIds` | `[]` — **anyone in the channel** | the only real authorisation control |

There are also 15 environment-only knobs — timeouts, heartbeat, post size, audit path,
and the local test harness — all documented in `.env.example`.

`npm run reload` validates everything **before** touching the running bridge, then
restarts it inside its existing tmux window — so the secrets never leave that shell.
Nothing is lost: sessions live on disk and resume by their derived id, so conversations
survive a reload.

Secrets are deliberately **not** allowed in this file. Environment variables override
anything set here, for one-off runs.

`allowedAadIds` is the only real authorisation control. HMAC proves a message came from
Teams; it says nothing about *who* sent it. Send one message and the bridge logs the
sender's `aadObjectId`; put that in the list.

### How the replies sound

`prompts/teams-voice.md` is appended to the system prompt on every turn. It is what
stops the agent answering a phone with a screenful of diff — it tells the agent it is
being read aloud, to lead with the outcome, never to paste code, and to ask questions
one at a time with **numbered options** so you can reply "do #2" from a car.

It is worth more than it sounds. The same question, with and without it:

| | characters | code block |
|---|---|---|
| without | 1460 | yes — pasted the whole implementation |
| with | 694 | no — wrote it to the repo, ran the tests, described it in five sentences |

Edit the markdown and `npm run reload`; no code change. Point `voiceFile` somewhere else
to use your own. If the file is missing the bridge still runs and the banner says so.

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

The dev tunnel is an **account-level object**, so `~/bin/devtunnel host teams-bridge`
from any box signed into the same account serves the *same URL*. Nothing in Teams or
Power Automate changes, and thread ids still derive to the same session ids.

> **Only one machine can host at a time.** Starting a host on the new box **silently
> evicts** the old one — and the evicted side never reconnects, while its tmux session,
> its process and `devtunnel show` all still look healthy. Stop the old host first.
> Recovery is to kill and restart that machine's tunnel session. See
> [FINDINGS §20](docs/FINDINGS.md).

Only two things are actually machine-specific: the tunnel CLI, and a git identity.
Everything else is the normal [Running it](#running-it) sequence.

```sh
# 0. on the OLD box first - a second host evicts it silently
tmux kill-session -t tunnel

# 1. tunnel CLI (the only genuinely new work)
curl -sL https://aka.ms/DevTunnelCliInstall | bash
chmod +x ~/bin/devtunnel
sudo apt install -y libicu-dev
cat > ~/bin/xdg-open <<'EOF'
#!/usr/bin/env bash
exec powershell.exe -NoProfile -Command "Start-Process '$1'"
EOF
chmod +x ~/bin/xdg-open
export PATH="$HOME/bin:$PATH"
~/bin/devtunnel user login -b -e          # NOT -d, and do NOT run `create`
~/bin/devtunnel show teams-bridge         # should print the tunnel and its port

# 2. the repo, and a GLOBAL git identity
git clone https://github.com/arajawat/code-from-teams.git
cd code-from-teams
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

Then follow **[Running it](#running-it)** from step 1 — dependencies, secrets, settings,
start, read the banner. Do not skip the secrets step because the old box "already had
them": secrets live in `.env`, which is gitignored and therefore *not* in your clone.

Sign in with the **same account** the tunnel belongs to — `~/bin/devtunnel user show`
on the old box tells you which. A different account authenticates fine and then simply
cannot see `teams-bridge`. The missing **global** git identity is the classic trap: it
surfaces as a failed commit minutes into a turn rather than at startup, so the startup
banner checks it for you.

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
