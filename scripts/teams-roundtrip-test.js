// Teams <-> bridge round-trip test.
//
// Proves four things in one run:
//   1. immediate reply inside the outgoing-webhook 5s HTTP window
//   2. a DELAYED reply (5 min later) landing in the SAME thread, via Power Automate
//   3. the agent asking a question with options + a recommendation
//   4. routing: the next message is treated as the ANSWER, not a new prompt
//
// env:
//   TEAMS_WEBHOOK_SECRET  inbound HMAC token from the outgoing webhook
//   TEAMS_FLOW_URL        outbound POST url from the Power Automate flow
//
// run:
//   read -rs TEAMS_WEBHOOK_SECRET && export TEAMS_WEBHOOK_SECRET
//   read -rs TEAMS_FLOW_URL       && export TEAMS_FLOW_URL
//   node teams-roundtrip-test.js

const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT ?? 3978);
const SECRET = process.env.TEAMS_WEBHOOK_SECRET;
const FLOW_URL = process.env.TEAMS_FLOW_URL;

const num = (name, dflt) => Number(process.env[name] ?? dflt);
const DELAYED_REPLY_MS = num("DELAYED_REPLY_MS", 5 * 60 * 1000); // "5 min later" leg
const QUESTION_DELAY_MS = num("QUESTION_DELAY_MS", 5 * 1000); // pause before asking
const ANSWER_TIMEOUT_MS = num("ANSWER_TIMEOUT_MS", 10 * 60 * 1000); // deadlock guard

// threadRoot -> resolver for a parked question. In-memory only, by design:
// it covers an in-flight turn, which dies on restart anyway.
const pending = new Map();
// threadRoots we have already started a scenario for, so a stray message
// does not kick off a second one.
const active = new Set();

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(stamp().padStart(8), ...a);

function isSignatureValid(rawBody, header) {
  if (!SECRET) return true; // verification disabled
  if (!header || !header.startsWith("HMAC ")) return false;
  const provided = header.slice(5).trim();
  const expected = crypto
    .createHmac("sha256", Buffer.from(SECRET, "base64"))
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Teams sends HTML in `text` even though textFormat says "plain".
function toPlainText(raw) {
  if (!raw) return "";
  return raw
    .replace(/<at\b[^>]*>.*?<\/at>/gi, "") // strip the @mention
    .replace(/<[^>]+>/g, "") // strip remaining tags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

// The `;messageid=` suffix is the thread root and is STABLE across a thread.
// Do NOT fall back to replyToId: it is null even for genuine in-thread replies.
function threadRootOf(activity) {
  const convId = activity?.conversation?.id ?? "";
  const idx = convId.indexOf(";messageid=");
  return idx === -1 ? null : convId.slice(idx + ";messageid=".length);
}

async function postToThread(threadRoot, text) {
  if (!FLOW_URL) {
    log("!! TEAMS_FLOW_URL not set, would have posted:", JSON.stringify(text));
    return;
  }
  const started = Date.now();
  const res = await fetch(FLOW_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadRoot, text }),
  });
  const ms = Date.now() - started;
  const body = await res.text().catch(() => "");
  log(`flow POST -> ${res.status} in ${ms}ms`, body ? `body: ${body.slice(0, 200)}` : "");
  if (!res.ok) log("!! flow call failed, the delayed leg will not appear in Teams");
}

function askQuestion(threadRoot, question, choices, recommended) {
  const lines = [question, ""];
  choices.forEach((c, i) => {
    const tag = c === recommended ? "  <-- recommended" : "";
    lines.push(`${i + 1}. ${c}${tag}`);
  });
  lines.push("");
  lines.push("Reply with a number, or just say it in your own words.");
  lines.push("(@mention me in your reply, or I will not see it.)");

  const parked = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(threadRoot);
      reject(new Error("answer timeout"));
    }, ANSWER_TIMEOUT_MS);
    pending.set(threadRoot, (answer) => {
      clearTimeout(timer);
      pending.delete(threadRoot);
      resolve(answer);
    });
  });

  return postToThread(threadRoot, lines.join("\n")).then(() => parked);
}

async function runScenario(threadRoot) {
  try {
    log(`scenario start for thread ${threadRoot}`);

    await new Promise((r) => setTimeout(r, QUESTION_DELAY_MS));

    const asked = Date.now();
    let answer;
    try {
      answer = await askQuestion(
        threadRoot,
        "Quick check while I work - how should I report progress on long tasks?",
        ["only when done", "every milestone", "milestones + a heartbeat"],
        "every milestone",
      );
    } catch (e) {
      log("question was never answered:", e.message);
      await postToThread(threadRoot, "No answer, so I timed out. Ask me again.");
      return;
    }
    log(`ANSWER received after ${((Date.now() - asked) / 1000).toFixed(1)}s:`,
        JSON.stringify(answer));

    await postToThread(
      threadRoot,
      `Got it: "${answer}".\n\nNow going quiet for 5 minutes, then I will post ` +
        `again in THIS thread. If that message shows up here and not as a new post, ` +
        `the delayed-notification path works.`,
    );

    log(`sleeping ${DELAYED_REPLY_MS / 1000}s before the delayed leg...`);
    await new Promise((r) => setTimeout(r, DELAYED_REPLY_MS));

    const mins = (DELAYED_REPLY_MS / 60000).toFixed(0);
    await postToThread(
      threadRoot,
      `Done. This arrived ${mins} minutes after your message, with no prompting ` +
        `from you.\n\nIf you are reading it inside the original thread: the ` +
        `long-running notification path is proven.`,
    );
    log("scenario complete");
  } catch (e) {
    log("scenario crashed:", e.stack || e.message);
    await postToThread(threadRoot, `Scenario crashed: ${e.message}`).catch(() => {});
  } finally {
    active.delete(threadRoot);
  }
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const ok = isSignatureValid(raw, req.headers.authorization);

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

    console.log("─".repeat(70));
    log(`signature  : ${ok}`);
    log(`from       : ${who}`);
    log(`text       : ${JSON.stringify(text)}`);
    log(`threadRoot : ${threadRoot}`);

    const reply = (t) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "message", text: t }));
    };

    if (!ok) {
      log("REJECTED: bad signature");
      reply("Rejected: signature check failed.");
      return;
    }
    if (!threadRoot) {
      log("REJECTED: no thread root");
      reply("Could not work out the thread id.");
      return;
    }

    // Is this the answer to a question we parked?
    const resolver = pending.get(threadRoot);
    if (resolver) {
      log("ROUTED AS ANSWER to a parked question");
      resolver(text);
      reply("Thanks, noted.");
      return;
    }

    if (active.has(threadRoot)) {
      log("scenario already running for this thread, ignoring");
      reply("Already working on this thread.");
      return;
    }

    log("ROUTED AS NEW PROMPT, starting scenario");
    active.add(threadRoot);
    runScenario(threadRoot); // deliberately not awaited
    reply("Got it. I will ask you something shortly, then report back in 5 minutes.");
  });
});

server.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}/api/messages`);
  console.log(`HMAC verification ${SECRET ? "ON" : "OFF (no TEAMS_WEBHOOK_SECRET)"}`);
  console.log(`outbound flow    ${FLOW_URL ? "SET" : "NOT SET (delayed leg will no-op)"}`);
});
