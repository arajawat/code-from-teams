// Send a fake Teams message to the bridge, correctly HMAC-signed.
//
// Lets the full path be exercised locally: signature check, HTML stripping,
// thread-root extraction, routing, and the Copilot turn itself.
//
//   node scripts/fakemsg.js "add a hello function to util.js"
//   node scripts/fakemsg.js --thread 999 "second message in the same thread"

const crypto = require("crypto");

const SECRET = process.env.TEAMS_WEBHOOK_SECRET;
const URL = process.env.BRIDGE_URL ?? "http://localhost:3978/api/messages";

const args = process.argv.slice(2);
let thread = process.env.FAKE_THREAD ?? "9999999999999";
const ti = args.indexOf("--thread");
if (ti !== -1) {
  thread = args[ti + 1];
  args.splice(ti, 2);
}
const text = args.join(" ");
if (!text) {
  console.error('usage: node scripts/fakemsg.js [--thread <id>] "your message"');
  process.exit(1);
}

// Shaped like a real outgoing-webhook payload, including the HTML that Teams
// sends in `text` despite textFormat saying "plain".
const activity = {
  type: "message",
  id: String(Date.now()),
  timestamp: new Date().toISOString(),
  textFormat: "plain",
  text: `<p><at>bridge</at>&nbsp;${text}</p>`,
  from: {
    id: "29:fake",
    name: process.env.FAKE_NAME ?? "Local Tester",
    aadObjectId: process.env.FAKE_AAD_ID ?? "00000000-0000-0000-0000-000000000000",
  },
  conversation: { id: `19:fakechannel@thread.tacv2;messageid=${thread}` },
  replyToId: null,
};

const body = JSON.stringify(activity);
const headers = { "Content-Type": "application/json" };
if (SECRET) {
  const mac = crypto
    .createHmac("sha256", Buffer.from(SECRET, "base64"))
    .update(body)
    .digest("base64");
  headers.Authorization = `HMAC ${mac}`;
}

const started = Date.now();
fetch(URL, { method: "POST", headers, body })
  .then(async (r) => {
    const txt = await r.text();
    console.log(`${r.status} in ${Date.now() - started}ms`);
    try {
      console.log("bridge replied:", JSON.parse(txt).text);
    } catch {
      console.log("bridge replied:", txt);
    }
  })
  .catch((e) => console.error("request failed:", e.message));
