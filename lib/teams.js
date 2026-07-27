// Teams transport helpers.
//
// Every function here was proven against real Teams traffic before the Copilot
// SDK was wired in. Treat changes with suspicion: each one encodes a quirk that
// cost real debugging time. See docs/FINDINGS.md section 6.

const crypto = require("crypto");

// Teams signs the raw request body with the outgoing webhook's base64 secret.
// Compare in constant time; the header looks like "HMAC <base64>".
function isSignatureValid(rawBody, header, secret) {
  if (!secret) return true; // verification disabled
  if (!header || !header.startsWith("HMAC ")) return false;
  const provided = header.slice(5).trim();
  const expected = crypto
    .createHmac("sha256", Buffer.from(secret, "base64"))
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Teams sends HTML in `text` even though textFormat says "plain".
// Real payload: "<p><at>testhook</at>&nbsp;hello</p>"
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

// The `;messageid=` suffix of conversation.id is the thread root, and it is
// STABLE for the life of the thread. That stability is what lets us derive the
// Copilot session id instead of storing a mapping.
//
// Do NOT fall back to replyToId: it is null even for genuine in-thread replies,
// so `(replyToId ?? id)` silently keys every message to a new session.
function threadRootOf(activity) {
  const convId = activity?.conversation?.id ?? "";
  const idx = convId.indexOf(";messageid=");
  return idx === -1 ? null : convId.slice(idx + ";messageid=".length);
}

// The Copilot session id for a thread. A pure function of the thread root:
// no map, no file, no race, and a thread from last week resolves to the same
// id it had when it started.
function sessionIdFor(threadRoot) {
  return `teams-${threadRoot}`;
}

// Anything after the outgoing webhook's 5-second window has to go out through
// Power Automate. `threadRoot` is passed as the flow's Message Id, which is
// what makes the post land inside the original thread rather than as a new one.
async function postToThread(flowUrl, threadRoot, text) {
  if (!flowUrl) {
    return { skipped: true, status: 0, ms: 0 };
  }
  const started = Date.now();
  const res = await fetch(flowUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadRoot, text }),
  });
  await res.text().catch(() => "");
  return { skipped: false, status: res.status, ok: res.ok, ms: Date.now() - started };
}

module.exports = {
  isSignatureValid,
  toPlainText,
  threadRootOf,
  sessionIdFor,
  postToThread,
};
