// The bridge: Teams thread <-> Copilot SDK session.
//
// One Teams thread == one Copilot session == one conversation with memory.
// The session id is DERIVED from the thread root, never stored, so a thread you
// started last week resumes with full context and no bookkeeping.
//
// Inbound  : Teams outgoing webhook (must answer within 5 seconds)
// Outbound : Power Automate flow (anything after those 5 seconds)
// See docs/DESIGN.md for why those are two different mechanisms.
//
// Settings: bridge.config.json (repo path, model, effort, yolo, allowlist).
// Secrets stay in the environment and never touch that file:
//   TEAMS_WEBHOOK_SECRET   inbound HMAC token from the outgoing webhook
//   TEAMS_FLOW_URL         outbound POST url from the Power Automate flow
// Edit the config, then `npm run reload`.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { CopilotClient, approveAll } = require("@github/copilot-sdk");
const {
  isSignatureValid,
  toPlainText,
  threadRootOf,
  sessionIdFor,
  postToThread,
} = require("../lib/teams");
const { load: loadConfig, checkRepo, CONFIG_PATH } = require("../lib/config");

const num = (name, dflt) => Number(process.env[name] ?? dflt);

const PORT = num("PORT", 3978);
const SECRET = process.env.TEAMS_WEBHOOK_SECRET;
const FLOW_URL = process.env.TEAMS_FLOW_URL;
const AUDIT_PATH = process.env.AUDIT_LOG ?? path.join(__dirname, "..", "audit.jsonl");

// Non-secret settings come from bridge.config.json (see lib/config.js), so
// pointing this at a different repo is a file edit and a reload, not a code change.
// Model and effort are PINNED rather than left to the runtime default: that default
// drifts as new models ship, and it resolved to effort "medium" - the agent was
// quietly thinking less hard than it could.
const cfg = loadConfig();
const REPO_DIR = cfg.repoDir;
const MODEL = cfg.model;
const EFFORT = cfg.effort;
// Appended to the system prompt so replies suit someone reading on a phone
// rather than a terminal. Null if the file is missing - the banner says so.
const VOICE = cfg.voice;

// Who is allowed to drive the agent. HMAC proves a message came from Teams; it
// says nothing about who typed it. This is the only real access control.
// Lowercased on both sides: aadObjectIds are GUIDs and casing is not guaranteed
// to be stable. A casing mismatch would lock you out of your own bridge with a
// message that says nothing about why.
const ALLOWED = cfg.allowedAadIds;

// Budget for the agent's own work. Time spent waiting for a human to answer a
// question is credited back, so a slow reply never kills a healthy turn.
const TURN_TIMEOUT_MS = num("TURN_TIMEOUT_MS", 30 * 60 * 1000);
// A parked question holds the turn open, and turns are serialized, so an
// unanswered question would freeze the bridge forever without this.
const ANSWER_TIMEOUT_MS = num("ANSWER_TIMEOUT_MS", 60 * 60 * 1000);
// Two minutes of silence looks broken, especially on a phone.
const MILESTONE_MIN_GAP_MS = num("MILESTONE_MIN_GAP_MS", 15 * 1000);
// How long the agent may work in silence before we fall back to naming the
// tool it is running, just to prove it is still alive.
const HEARTBEAT_MS = num("HEARTBEAT_MS", 45 * 1000);
// Teams chokes on very long messages, and nobody reads them at a traffic light.
const MAX_POST_CHARS = num("MAX_POST_CHARS", 3500);

// Tools whose names are noise in a chat thread. ask_user in particular would
// announce itself right after the question it is asking.
const QUIET_TOOLS = new Set(["ask_user", "store_memory", "vote_memory", "manage_schedule"]);

// Yolo: approve every tool the agent asks for, without asking the user.
// On by default - a permission prompt nobody can see is just a hang, and the
// person driving this is in a car. Set YOLO=0 to deny instead (useful for
// proving what the agent *would* have done without letting it).
//
// This is NOT the same as suppressing the agent's questions. Permission
// prompts ("may I edit this file?") are noise on a phone; design questions
// ("which approach do you want?") are the entire point of the product, and
// they keep working via onUserInputRequest.
const YOLO = cfg.yolo;

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(stamp().padStart(9), ...a);

// threadRoot -> resolver for a question the agent is waiting on.
// In-memory by design: it belongs to an in-flight turn, which dies on restart
// anyway. If the bridge restarts mid-question the answer is treated as a new
// prompt, which is recoverable; a stale resolver on disk would not be.
const pending = new Map();
// threadRoot -> milestone poster for the turn currently running.
const posters = new Map();
// Turns are serialized: they share one working directory, so two at once would
// corrupt each other. Holds the threadRoot of the active turn, or null.
let activeThread = null;

function audit(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFile(AUDIT_PATH, line + "\n", (err) => {
    if (err) log("!! audit write failed:", err.message);
  });
}

function clip(text) {
  if (text.length <= MAX_POST_CHARS) return text;
  return text.slice(0, MAX_POST_CHARS) + "\n\n[...truncated]";
}

async function post(threadRoot, text) {
  const r = await postToThread(FLOW_URL, threadRoot, clip(text));
  if (r.skipped) {
    log("!! TEAMS_FLOW_URL not set, would have posted:", JSON.stringify(text.slice(0, 120)));
    return;
  }
  log(`flow POST -> ${r.status} in ${r.ms}ms`);
  if (!r.ok) log("!! flow call failed, this message never reached Teams");
}

// Progress reporting, two lanes.
//
// Content (the agent's own words) is queued and never dropped. Progress
// (what it is currently doing) is a single slot where the newest wins, because
// a superseded "reading auth.js" is worth nothing once it has moved on.
// Both share one rate limit so a phone does not buzz continuously.
function makeMilestonePoster(threadRoot) {
  const content = [];
  const startedAt = Date.now();
  let progress = null;
  let timer = null;
  let lastPostAt = 0;
  let lastPosted = "";
  let stopped = false;

  const flush = async () => {
    timer = null;
    if (stopped) return;
    let item = null;
    if (content.length) {
      item = content.shift();
    } else if (progress !== null) {
      item = { text: progress };
      progress = null;
    }
    if (item === null) return;
    if (item.text === lastPosted) {
      item.done?.();
      return schedule();
    }
    lastPosted = item.text;
    lastPostAt = Date.now();
    await post(threadRoot, item.text).catch((e) => log("!! milestone post failed:", e.message));
    item.done?.();
    schedule();
  };

  const schedule = () => {
    if (stopped || timer) return;
    if (!content.length && progress === null) return;
    const wait = Math.max(0, MILESTONE_MIN_GAP_MS - (Date.now() - lastPostAt));
    timer = setTimeout(flush, wait);
  };

  return {
    // The agent said something worth keeping.
    say(text) {
      const t = (text ?? "").trim();
      if (t) content.push({ text: t });
      schedule();
    },
    // Queue a message and resolve once it has actually reached Teams.
    // Questions go through here rather than posting directly: a direct post
    // jumps ahead of the explanation already queued behind the rate limit, so
    // the question arrived BEFORE the text that set it up.
    sayAndWait(text) {
      const t = (text ?? "").trim();
      if (!t) return Promise.resolve();
      return new Promise((resolve) => {
        content.push({ text: t, done: resolve });
        schedule();
      });
    },
    // The agent is doing something; only the latest matters.
    doing(text) {
      const t = (text ?? "").trim();
      if (t) progress = t;
      schedule();
    },
    // How long since anything actually reached Teams. Used to decide whether
    // the silence is long enough to justify a low-value heartbeat.
    quietFor() {
      return Date.now() - (lastPostAt || startedAt);
    },
    wasPosted(text) {
      return (text ?? "").trim() === lastPosted;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Never leave a sayAndWait caller parked on a queue that will not drain.
      for (const item of content) item.done?.();
      content.length = 0;
    },
  };
}

// Ask the user something and park until they reply in the same thread.
// Returned as a Promise, which is exactly what the SDK's onUserInputRequest
// accepts - so the agent simply blocks, as it would in a terminal.
function askQuestion(threadRoot, request) {
  const lines = [request.question, ""];
  const choices = request.choices ?? [];
  choices.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  if (choices.length) lines.push("");
  lines.push("Reply in this thread — and @mention me, or I will not see it.");

  const askedAt = Date.now();
  const parked = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(threadRoot);
      reject(new Error("question timed out"));
    }, ANSWER_TIMEOUT_MS);
    pending.set(threadRoot, (answer) => {
      clearTimeout(timer);
      pending.delete(threadRoot);
      const waited = Date.now() - askedAt;
      log(`ANSWER after ${(waited / 1000).toFixed(1)}s: ${JSON.stringify(answer)}`);
      resolve({ answer, waited });
    });
  });

  log(`ASKING: ${JSON.stringify(request.question)}`);
  audit({ kind: "question", threadRoot, question: request.question, choices });

  // Routed through the milestone queue, not posted directly, so it lands AFTER
  // whatever the agent already said to set the question up. Posting straight to
  // Teams here would overtake that queued text and arrive out of order.
  const poster = posters.get(threadRoot);
  const question = lines.join("\n");
  return (poster ? poster.sayAndWait(question) : post(threadRoot, question))
    .then(() => parked)
    .then(({ answer, waited }) => {
      // The agent should not be penalised for the time a human took to reply.
      turnGuard?.credit(waited);
      audit({ kind: "answer", threadRoot, answer, waitedMs: waited });
      // Map a bare "2" onto the choice it refers to, so the agent gets the
      // words it offered rather than a digit it has to re-interpret.
      const asIndex = Number(answer.trim());
      const picked =
        Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= choices.length
          ? choices[asIndex - 1]
          : answer;
      return { answer: picked, wasFreeform: picked === answer };
    });
}

// A deadline the agent's work must meet, which can be extended when the delay
// was ours to wait for rather than the agent's fault.
let turnGuard = null;
function makeTurnGuard(ms) {
  let deadline = Date.now() + ms;
  let done = false;
  const promise = new Promise((_, reject) => {
    const tick = () => {
      if (done) return;
      if (Date.now() >= deadline) return reject(new Error("turn timed out"));
      setTimeout(tick, 5000).unref();
    };
    setTimeout(tick, 5000).unref();
  });
  return {
    promise,
    credit: (extra) => {
      deadline += extra;
    },
    release: () => {
      done = true;
    },
  };
}

// The agent runs with the Teams secrets stripped from its environment. It has
// a shell, so anything left in process.env is one `env` away from being posted
// into the channel. Removing them at spawn time is a wall, not a filter.
const agentEnv = { ...process.env };
delete agentEnv.TEAMS_WEBHOOK_SECRET;
delete agentEnv.TEAMS_FLOW_URL;

const client = new CopilotClient({ env: agentEnv, workingDirectory: REPO_DIR });

// Every permission variant carries a human-readable `intention`, which is far
// more useful in an audit log than the tool name. Shell requests also carry
// the exact command, which is the thing worth being able to review later.
function describePermission(request) {
  const kind = request?.kind ?? "unknown";
  const detail =
    request?.fullCommandText ?? request?.fileName ?? request?.path ?? request?.url ?? null;
  return { kind, intention: request?.intention ?? null, detail };
}

// Resume the thread's session, or start it if this is the first message.
// Both paths use the SAME derived id, so an old thread picks up where it left
// off and a wiped session degrades to a fresh one rather than an error.
async function openSession(threadRoot) {
  const id = sessionIdFor(threadRoot);
  const config = {
    workingDirectory: REPO_DIR,
    infiniteSessions: { enabled: true },
    onPermissionRequest: (request, invocation) => {
      const what = describePermission(request);
      log(`${YOLO ? "auto-approved" : "DENIED"}: ${what.kind} — ${what.intention ?? ""}`);
      audit({
        kind: "permission",
        threadRoot,
        decision: YOLO ? "approve" : "deny",
        permissionKind: what.kind,
        intention: what.intention,
        detail: what.detail,
      });
      return YOLO ? approveAll(request, invocation) : { kind: "deny" };
    },
    onUserInputRequest: (request) => askQuestion(threadRoot, request),
    // Deliberately NOT provided: onElicitationRequest, onExitPlanModeRequest,
    // onAutoModeSwitchRequest, onMcpAuthRequest. Unlike permissions - which are
    // raised regardless and left pending when unhandled - these are capability
    // gated: "when provided, enables the callback". Leaving them off means the
    // agent never issues them, so they can never block the bridge. Adding a
    // handler here would enable a dialog we cannot render in a Teams thread.
  };
  // Set on the shared config so BOTH resume and create carry it. If it were set
  // only on create, every follow-up turn in a thread (which resumes) would
  // silently fall back to the default effort.
  if (MODEL) config.model = MODEL;
  if (EFFORT) config.reasoningEffort = EFFORT;
  // "append" keeps every SDK guardrail and adds our section. "replace" would
  // drop the built-in safety rules, which is not a trade worth making for tone.
  // Same resume/create reasoning as above: systemMessage is on SessionConfigBase.
  if (VOICE) config.systemMessage = { mode: "append", content: VOICE };

  try {
    const session = await client.resumeSession(id, config);
    log(`resumed session ${id}`);
    return { session, resumed: true };
  } catch (e) {
    log(`no session to resume (${e.message}), creating ${id}`);
    const session = await client.createSession({ ...config, sessionId: id });
    return { session, resumed: false };
  }
}

async function runTurn(threadRoot, prompt) {
  const poster = makeMilestonePoster(threadRoot);
  posters.set(threadRoot, poster);
  turnGuard = makeTurnGuard(TURN_TIMEOUT_MS);
  const startedAt = Date.now();
  let unsubscribe = null;

  try {
    const { session, resumed } = await openSession(threadRoot);
    log(`turn start (${resumed ? "resumed" : "new"}) prompt=${JSON.stringify(prompt)}`);

    // We wait for session.idle ourselves rather than using sendAndWait, whose
    // default 60s timeout would abandon any turn where the user takes longer
    // than a minute to answer a question - which is the normal case here.
    let lastAssistant = null;
    let armed = false;
    let resolveIdle;
    let rejectTurn;
    const idle = new Promise((resolve, reject) => {
      resolveIdle = resolve;
      rejectTurn = reject;
    });

    unsubscribe = session.on((event) => {
      switch (event.type) {
        case "assistant.intent":
          poster.doing(event.data.intent);
          break;
        case "assistant.message":
          lastAssistant = event;
          poster.say(event.data.content);
          break;
        case "tool.execution_start":
          // A raw tool name is the least useful thing we can send, so it is
          // only worth it to break a long silence. Never while the user is
          // being asked something - the question is the message.
          if (
            !pending.has(threadRoot) &&
            !QUIET_TOOLS.has(event.data.toolName) &&
            poster.quietFor() > HEARTBEAT_MS
          ) {
            poster.doing(`still working… (${event.data.toolName})`);
          }
          break;
        case "session.compaction_start":
          log("context compaction started (long thread being summarised)");
          break;
        case "session.managed_settings_resolved":
          // Enterprise policy can disable bypass-permissions ("yolo") mode.
          // If it is on, auto-approval may be capped and the agent will stall
          // on its first tool call with no obvious cause - so say so loudly.
          log(
            `managed settings: bypassPermissionsDisabled=` +
              `${event.data.bypassPermissionsDisabled}`,
          );
          if (event.data.bypassPermissionsDisabled) {
            log("!! enterprise policy restricts bypass-permissions mode on this session");
          }
          break;
        case "session.managed_settings_enforced":
          log("!! managed policy blocked something:", JSON.stringify(event.data).slice(0, 300));
          audit({ kind: "policy_enforced", threadRoot, data: event.data });
          break;
        case "session.error":
          log("!! session.error:", JSON.stringify(event.data).slice(0, 300));
          rejectTurn(new Error(event.data.message ?? "session error"));
          break;
        case "session.idle":
          if (armed) resolveIdle();
          break;
        default:
          break;
      }
    });

    armed = true;
    await session.send(prompt);
    await Promise.race([idle, turnGuard.promise]);

    // The final message comes from the event stream, not a return value.
    // AssistantMessageEvent puts the text at data.content; there is no .text.
    const finalText = lastAssistant?.data?.content;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`turn complete in ${elapsed}s`);

    if (!finalText) {
      await post(threadRoot, "That turn finished without a reply. Try asking again.");
    } else if (!poster.wasPosted(finalText)) {
      await post(threadRoot, finalText);
    } else {
      log("final message already posted as a milestone, not repeating it");
    }
    audit({ kind: "turn_complete", threadRoot, elapsedMs: Date.now() - startedAt });
  } catch (e) {
    log("turn failed:", e.stack || e.message);
    audit({ kind: "turn_failed", threadRoot, error: e.message });
    await post(threadRoot, `That turn failed: ${e.message}`).catch(() => {});
  } finally {
    turnGuard?.release();
    turnGuard = null;
    if (unsubscribe) unsubscribe();
    poster.stop();
    posters.delete(threadRoot);
    pending.delete(threadRoot);
    activeThread = null;
  }
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const signatureOk = isSignatureValid(raw, req.headers.authorization, SECRET);

    let activity;
    try {
      activity = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }

    const text = toPlainText(activity.text);
    const threadRoot = threadRootOf(activity);
    const who = activity?.from?.name ?? "?";
    const aadId = activity?.from?.aadObjectId ?? null;

    console.log("─".repeat(70));
    log(`from       : ${who} (${aadId ?? "no aad id"})`);
    log(`text       : ${JSON.stringify(text)}`);
    log(`threadRoot : ${threadRoot}`);

    const reply = (t) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "message", text: t }));
    };

    // Every inbound message is recorded, accepted or not.
    audit({ kind: "inbound", threadRoot, who, aadId, signatureOk, text });

    if (!signatureOk) {
      log("REJECTED: bad signature");
      reply("Rejected: signature check failed.");
      return;
    }
    if (!threadRoot) {
      log("REJECTED: no thread root");
      reply("Could not work out which thread this is.");
      return;
    }
    if (ALLOWED.length && !ALLOWED.includes((aadId ?? "").toLowerCase())) {
      log(`REJECTED: ${who} is not on the allowlist`);
      reply("You are not on the allowlist for this bridge.");
      return;
    }

    // Is this the answer to a question the agent is waiting on?
    const resolver = pending.get(threadRoot);
    if (resolver) {
      log("ROUTED AS ANSWER");
      resolver(text);
      reply("Got it, carrying on.");
      return;
    }

    if (activeThread === threadRoot) {
      log("turn already running for this thread");
      reply("Still working on the last one — I'll report back here.");
      return;
    }
    if (activeThread) {
      log(`busy with thread ${activeThread}`);
      reply("I'm busy with another thread right now. Try again once it finishes.");
      return;
    }
    if (!text) {
      reply("That came through empty — did you only send the @mention?");
      return;
    }

    log("ROUTED AS NEW PROMPT");
    activeThread = threadRoot;
    runTurn(threadRoot, text); // deliberately not awaited: the 5s window is ticking
    reply("On it 👍 I'll report back in this thread.");
  });
});

async function main() {
  await client.start();
  server.listen(PORT, () => {
    const repo = checkRepo(REPO_DIR);
    console.log(`bridge listening on http://localhost:${PORT}/api/messages`);
    console.log(`config           ${cfg.configPath ?? `${CONFIG_PATH} (none - using defaults)`}`);
    console.log(`repo dir         ${REPO_DIR}`);
    for (const n of repo.notes) console.log(`                 ${n}`);
    console.log(`model            ${MODEL ?? "(runtime default)"}  effort ${EFFORT ?? "(default)"}`);
    console.log(
      `voice prompt     ${
        VOICE
          ? `${cfg.voiceFile} (${VOICE.length} chars)`
          : `MISSING at ${cfg.voiceFile} - replies will not be phone-shaped`
      }`,
    );
    console.log(`HMAC             ${SECRET ? "ON" : "OFF (no TEAMS_WEBHOOK_SECRET)"}`);
    console.log(`yolo             ${YOLO ? "ON (all tools auto-approved)" : "OFF (tools denied)"}`);
    console.log(`outbound flow    ${FLOW_URL ? "SET" : "NOT SET (replies will no-op)"}`);
    console.log(`allowlist        ${ALLOWED.length ? ALLOWED.join(", ") : "OFF (anyone in the channel)"}`);
    console.log(`audit log        ${AUDIT_PATH}`);
    // Printed last so it is the thing left on screen. These are all fatal to
    // doing real work, and every one of them would otherwise surface as a
    // confusing failure several minutes into a turn.
    for (const p of repo.problems) console.log(`\n  ✗ ${p}`);
    if (repo.problems.length) console.log("");
  });
}

main().catch((e) => {
  console.error("failed to start:", e);
  process.exit(1);
});
