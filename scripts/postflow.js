// Post a message into a Teams thread via the Power Automate flow.
//
// usage:
//   read -rs TEAMS_FLOW_URL && export TEAMS_FLOW_URL
//   node postflow.js 1784956184852 "threaded reply test"
//
// Add --card to also send Adaptive-Card-shaped fields, in case the flow
// trigger validates the payload against the card schema.

const [, , threadRoot, ...rest] = process.argv;
const card = rest.includes("--card");
const text = rest.filter((a) => a !== "--card").join(" ");

if (!process.env.TEAMS_FLOW_URL) {
  console.error("TEAMS_FLOW_URL is not set");
  process.exit(1);
}
if (!threadRoot || !text) {
  console.error('usage: node postflow.js <threadRoot> "<text>" [--card]');
  process.exit(1);
}

const body = { threadRoot, text };
if (card) {
  body.type = "message";
  body.attachments = [];
}

const started = Date.now();
fetch(process.env.TEAMS_FLOW_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})
  .then(async (res) => {
    const ms = Date.now() - started;
    const txt = await res.text().catch(() => "");
    console.log(`HTTP ${res.status} in ${ms}ms`);
    if (txt) console.log(`body: ${txt.slice(0, 400)}`);
    if (res.status === 202 || res.ok) {
      console.log("\naccepted. now look in Teams:");
      console.log("  IN the original thread  -> R1 PASSES, threading works");
      console.log("  as a NEW top-level post -> R1 fails, Message Id was ignored");
    } else {
      console.log("\nflow rejected it. retry with --card if you have not already.");
    }
  })
  .catch((e) => console.error("request failed:", e.message));
