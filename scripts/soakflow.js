// Soak test: does the flow stay enabled, or get suspended by policy?
//
// Posts to the flow on a fixed interval and reports every result, so a silent
// suspension shows up as the exact minute the status changes.
//
// usage:
//   read -rs TEAMS_FLOW_URL && export TEAMS_FLOW_URL
//   node soakflow.js 1784956184852            # default: every 60s for 15 min
//   node soakflow.js 1784956184852 30 10      # every 30s for 10 min
//
// Leave it running and get on with something else. Ctrl+C to stop.

const [, , threadRoot, everySecArg, forMinArg] = process.argv;
const everyMs = Number(everySecArg ?? 60) * 1000;
const forMs = Number(forMinArg ?? 15) * 60 * 1000;

if (!process.env.TEAMS_FLOW_URL) {
  console.error("TEAMS_FLOW_URL is not set");
  process.exit(1);
}
if (!threadRoot) {
  console.error("usage: node soakflow.js <threadRoot> [everySeconds] [forMinutes]");
  process.exit(1);
}

const started = Date.now();
let n = 0;
let ok = 0;
let bad = 0;
let firstFailureAt = null;

const mins = () => ((Date.now() - started) / 60000).toFixed(1).padStart(5);

async function ping() {
  n += 1;
  const label = `#${String(n).padStart(3)}  t+${mins()}m`;
  try {
    const res = await fetch(process.env.TEAMS_FLOW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadRoot, text: `soak ping ${n} (t+${mins()}m)` }),
    });
    if (res.ok || res.status === 202) {
      ok += 1;
      console.log(`${label}  HTTP ${res.status}  OK`);
    } else {
      bad += 1;
      if (firstFailureAt === null) firstFailureAt = mins();
      const body = await res.text().catch(() => "");
      console.log(`${label}  HTTP ${res.status}  FAILED  ${body.slice(0, 160)}`);
    }
  } catch (e) {
    bad += 1;
    if (firstFailureAt === null) firstFailureAt = mins();
    console.log(`${label}  network error: ${e.message}`);
  }
}

function summary() {
  console.log("─".repeat(60));
  console.log(`sent ${n}, ok ${ok}, failed ${bad}`);
  if (bad === 0) {
    console.log("flow stayed alive for the whole window. R7 looks clear.");
  } else {
    console.log(`first failure at t+${firstFailureAt}m -> flow was suspended.`);
    console.log("check the flow's run history and the disable notification.");
  }
}

console.log(
  `soaking every ${everyMs / 1000}s for ${forMs / 60000} min, thread ${threadRoot}`,
);
ping();
const timer = setInterval(ping, everyMs);
setTimeout(() => {
  clearInterval(timer);
  summary();
  process.exit(bad === 0 ? 0 : 1);
}, forMs);

process.on("SIGINT", () => {
  clearInterval(timer);
  summary();
  process.exit(0);
});
