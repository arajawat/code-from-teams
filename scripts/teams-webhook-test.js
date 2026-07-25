// Minimal Teams outgoing-webhook receiver, for testing the bridge pipe.
// Usage:  TEAMS_WEBHOOK_SECRET='<security token from Teams>' node teams-webhook-test.js
//
// Then expose port 3978 with VS Code port forwarding (Ports panel -> Forward a Port
// -> 3978 -> set visibility to Public) and paste that https URL + "/api/messages"
// as the outgoing webhook's Callback URL.

const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT ?? 3978);
const SECRET = process.env.TEAMS_WEBHOOK_SECRET ?? "";

function isSignatureValid(rawBody, authHeader) {
  if (!SECRET) return null; // no secret configured -> skip verification
  if (!authHeader?.startsWith("HMAC ")) return false;
  const provided = authHeader.slice(5).trim();
  const expected = crypto
    .createHmac("sha256", Buffer.from(SECRET, "base64"))
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Teams sends `text` as HTML despite advertising textFormat "plain",
// e.g. "<p><at>testhook</at>&nbsp;hello</p>"
function toPlainText(html) {
  return String(html ?? "")
    .replace(/<at>.*?<\/at>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end("POST only");
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks);
    const valid = isSignatureValid(rawBody, req.headers.authorization);

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      payload = null;
    }

    const text = toPlainText(payload?.text);
    const conversationId = payload?.conversation?.id ?? "";
    const channelId = payload?.channelData?.teamsChannelId ?? "";
    // Candidate session key: the thread root, i.e. the ";messageid=" suffix.
    const threadRoot = conversationId.split(";messageid=")[1] ?? "(none)";

    console.log("─".repeat(70));
    console.log("signature      :", valid === null ? "NOT CHECKED (no secret set)" : valid);
    console.log("user (aadOid)  :", payload?.from?.aadObjectId ?? "unknown");
    console.log("clean text     :", JSON.stringify(text));
    console.log();
    console.log("message id     :", payload?.id);
    console.log("replyToId      :", payload?.replyToId ?? "null  (= new top-level post)");
    console.log("channel id     :", channelId);
    console.log("THREAD ROOT    :", threadRoot, " <-- must stay SAME across a thread");
    console.log("=> sessionId   :", `teams-${threadRoot}`);

    if (valid === false) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", text: "Signature check failed." }));
      return;
    }

    // Must respond within 5 seconds, in this exact shape.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", text: `got it: "${text.trim()}"` }));
  });
});

server.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}/api/messages`);
  console.log(SECRET ? "HMAC verification ON" : "HMAC verification OFF (set TEAMS_WEBHOOK_SECRET)");
});
