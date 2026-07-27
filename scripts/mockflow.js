// Local stand-in for the Power Automate flow.
//
// Prints whatever the bridge would have posted into Teams, so the whole loop
// can be exercised without spending real messages. Point the bridge at it with
//   TEAMS_FLOW_URL=http://localhost:3999/flow

const http = require("http");

const PORT = Number(process.env.MOCK_FLOW_PORT ?? 3999);
const t0 = Date.now();

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = { text: raw };
      }
      const at = `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
      console.log("\n" + "═".repeat(72));
      console.log(`${at}  → TEAMS  (thread ${body.threadRoot})`);
      console.log("═".repeat(72));
      console.log(body.text);
      res.writeHead(202).end('{"ok":true}');
    });
  })
  .listen(PORT, () => console.log(`mock flow listening on http://localhost:${PORT}/flow`));
