// Generates the README's animated demo, as SVG.
//
// WHY SVG AND NOT A GIF: a GIF needs ffmpeg + asciinema/vhs to build, lands in
// git as an unreviewable binary, and looks soft on a retina screen. An SVG with
// CSS keyframes animates in a GitHub README exactly the same way (camo strips
// scripts, not declarative animation), stays sharp at any size, is a few KB of
// text, and shows up in a diff when someone edits it.
//
// WHAT IT SHOWS: the real run recorded in docs/FINDINGS.md section 13 - the same
// timings, the same order of events, the same "lets do #1". The wording of the
// message bodies is condensed to fit a phone-sized frame. Nothing about the
// sequence is invented; if you change the demo, change it to match a real log.
//
//   npm run demo          ->  assets/demo-thread.svg   (the one in the README)
//   npm run demo -- --all ->  also the split and log-only cuts
//
// The extra two are for slides and issue threads, not the README - the README
// deliberately leads with the phone, because that is the side of this that a
// person who has never seen the project understands without being told.

"use strict";

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "assets");
const T = 24; // loop length in seconds

const COL = {
  card: "#0d1117",
  panel: "#010409",
  edge: "#30363d",
  edgeSoft: "#21262d",
  dim: "#6e7681",
  txt: "#c9d1d9",
  white: "#e6edf3",
  green: "#3fb950",
  blue: "#58a6ff",
  yellow: "#d29922",
  purple: "#bc8cff",
  mine: "#1f6feb",
  theirs: "#1c2128",
};

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Word wrap. Proportional fonts cannot be measured here, so callers pass a
// deliberately pessimistic character budget - a short line looks fine, an
// overflowing one runs outside the bubble.
function wrap(text, max) {
  const out = [];
  for (const para of String(text).split("\n")) {
    if (!para) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      if (!line) line = word;
      else if ((line + " " + word).length <= max) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

// One keyframes rule per element. Every element shares the same 24s cycle and
// differs only in the percentage at which it fades in, so the whole replay runs
// off a single clock and restarts cleanly. Elements stay visible until the loop
// wraps, which is what makes it read as a transcript rather than a slideshow.
function newDoc() {
  const kf = [];
  return {
    kf,
    at(t, { dur = 0.4, slide = 6 } = {}) {
      if (t < 0) return ""; // always visible: the startup banner
      const i = kf.length;
      const p0 = ((t / T) * 100).toFixed(3);
      const p1 = (((t + dur) / T) * 100).toFixed(3);
      kf.push(
        `@keyframes a${i}{0%,${p0}%{opacity:0;transform:translateY(${slide}px)}` +
          `${p1}%,100%{opacity:1;transform:translateY(0)}}`,
      );
      return ` style="animation:a${i} ${T}s infinite both"`;
    },
  };
}

// ---------------------------------------------------------------------------
// The transcript. `at` is seconds into the loop; the gaps are proportional to
// the real run, which is why the 48.5s the user spent away is the longest one.
// ---------------------------------------------------------------------------

const CHAT = [
  {
    at: 0.3,
    who: "me",
    text: "@copilot look at util.js and add input validation to every exported function. ask me first how strict to be.",
  },
  { at: 1.9, who: "bot", text: "On it \u{1F44D} I'll report back in this thread." },
  {
    at: 7.4,
    who: "bot",
    text:
      "How strict should validation on add be?\n\n" +
      "1. Reject anything non-numeric\n" +
      "2. Coerce numeric strings\n" +
      "3. Only guard null and undefined\n\n" +
      "I'd pick 1. Reply here and @mention me, or I won't see it.",
  },
  { at: 9.3, who: "park", text: "you put the phone down \u00b7 48.5s" },
  { at: 12.7, who: "me", text: "@copilot lets do #1" },
  {
    at: 18.0,
    who: "bot",
    text: "Done. add, sub and mul now reject non-numeric input, and the suite passes 9 of 9. Want me to commit it?",
  },
  { at: 19.6, who: "stat", text: "91.7s  \u00b7  7 tools auto-approved  \u00b7  nothing stored" },
];

const g = COL.green;
const b = COL.blue;
const y = COL.yellow;
const p = COL.purple;
const d = COL.dim;
const w = COL.white;

// Segments are [text, colour]. Rendered as sequential tspans in one monospace
// <text>, so alignment is exact without measuring anything.
const LOG = [
  { at: -1, seg: [["  repo dir      ", d], ["~/work/pgtoolsservice", w], ["  on ", d], ["teams-bridge", p]] },
  { at: -1, seg: [["  model         ", d], ["claude-opus-5", w], ["   effort ", d], ["xhigh", w]] },
  { at: -1, seg: [["  HMAC          ", d], ["ON", g], ["      yolo ", d], ["ON", g], [" (all tools auto-approved)", d]] },
  { at: -1, seg: [["  outbound flow ", d], ["SET", g], ["     allowlist ", d], ["1 id", w]] },
  { at: -1, seg: [["  bridge listening on ", d], [":3978/api/messages", b]] },
  { at: -1, seg: [[" ", d]] },

  { at: 0.9, sep: true },
  { at: 1.1, seg: [[" +387.6s ", d], ["from       : ", d], ["arajawat", w], [" (1a2b3c4d\u2026)", d]] },
  { at: 1.3, seg: [[" +387.6s ", d], ["text       : ", d], ["\"add input validation to util.js\u2026\"", w]] },
  { at: 1.5, seg: [[" +387.6s ", d], ["threadRoot : ", d], ["1785136979855", w]] },
  { at: 2.2, seg: [[" +387.6s ", d], ["ROUTED AS NEW PROMPT", b]] },
  { at: 2.9, seg: [[" +387.7s ", d], ["creating session ", d], ["teams-1785136979855", p]] },
  { at: 3.7, seg: [[" +393.2s ", d], ["auto-approved: ", g], ["read  ", w], ["\u2014 Search for files", d]] },
  { at: 4.5, seg: [[" +395.4s ", d], ["auto-approved: ", g], ["read  ", w], ["\u2014 Read file: util.js", d]] },
  { at: 5.3, seg: [[" +401.4s ", d], ["auto-approved: ", g], ["shell ", w], ["\u2014 List repo files", d]] },
  { at: 6.1, seg: [[" +403.8s ", d], ["auto-approved: ", g], ["read  ", w], ["\u2014 Read file: util.test.js", d]] },
  { at: 7.0, seg: [[" +409.2s ", d], ["ASKING: ", y], ["\"How strict should validation be?\u2026\"", w]] },
  { at: 8.2, seg: [[" +410.3s ", d], ["flow POST \u2192 ", d], ["202", g], [" in 1182ms", d]] },

  { at: 9.3, sep: true },
  { at: 9.6, seg: [["          ", d], ["parked \u2014 the turn is held open, not polling", y]] },

  { at: 12.9, seg: [[" +457.6s ", d], ["text       : ", d], ["\"lets do #1\"", w]] },
  { at: 13.4, seg: [[" +457.6s ", d], ["ROUTED AS ANSWER", b]] },
  { at: 13.8, seg: [[" +457.6s ", d], ["ANSWER after ", d], ["48.5s", y]] },
  { at: 14.9, seg: [[" +463.4s ", d], ["auto-approved: ", g], ["write ", w], ["\u2014 Edit file", d]] },
  { at: 15.7, seg: [[" +468.4s ", d], ["auto-approved: ", g], ["write ", w], ["\u2014 Edit file", d]] },
  { at: 16.5, seg: [[" +475.8s ", d], ["auto-approved: ", g], ["shell ", w], ["\u2014 Run node test suite", d]] },
  { at: 17.3, seg: [[" +479.4s ", d], ["turn complete in ", g], ["91.7s", g]] },
];

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function chatPanel(doc, { width, font, lh, chars }) {
  const pad = 10;
  const gap = 9;
  const charW = font * 0.58; // pessimistic: better a short line than an overflow
  const maxBubble = width - 34;
  const parts = [];
  let cy = 0;

  for (const m of CHAT) {
    if (m.who === "park") {
      const label = m.text;
      const tw = label.length * (font * 0.56);
      const cx = width / 2;
      parts.push(
        `<g${doc.at(m.at)}>` +
          `<line x1="6" y1="${cy + 9}" x2="${(cx - tw / 2 - 10).toFixed(1)}" y2="${cy + 9}" stroke="${COL.edgeSoft}" stroke-width="1"/>` +
          `<line x1="${(cx + tw / 2 + 10).toFixed(1)}" y1="${cy + 9}" x2="${width - 6}" y2="${cy + 9}" stroke="${COL.edgeSoft}" stroke-width="1"/>` +
          `<text x="${cx}" y="${cy + 13}" text-anchor="middle" font-family="${SANS}" font-size="${font - 1.5}" fill="${COL.yellow}">${esc(label)}</text>` +
          `</g>`,
      );
      cy += 18 + gap;
      continue;
    }

    if (m.who === "stat") {
      parts.push(
        `<g${doc.at(m.at)}>` +
          `<rect x="0" y="${cy}" width="${width}" height="26" rx="6" fill="${COL.theirs}" stroke="${COL.edgeSoft}"/>` +
          `<text x="${width / 2}" y="${cy + 17}" text-anchor="middle" font-family="${MONO}" font-size="${font - 1.5}" fill="${COL.green}">${esc(m.text)}</text>` +
          `</g>`,
      );
      cy += 26 + gap;
      continue;
    }

    const mine = m.who === "me";
    const lines = wrap(m.text, chars);
    const longest = lines.reduce((n, l) => Math.max(n, l.length), 0);
    const bw = Math.min(maxBubble, Math.max(70, longest * charW + pad * 2));
    const bh = lines.length * lh + pad * 2 - (lh - font) + 2;
    const bx = mine ? width - bw : 0;
    const fill = mine ? COL.mine : COL.theirs;
    const stroke = mine ? COL.mine : COL.edgeSoft;
    const colour = mine ? "#ffffff" : COL.txt;

    // A truly empty tspan is skipped by some renderers, which collapses the
    // blank line but not the height reserved for it - leaving dead space at the
    // bottom of the bubble. A non-breaking space keeps the line real.
    const tspans = lines
      .map((l, i) =>
        i === 0
          ? `<tspan x="${bx + pad}" y="${(cy + pad + font * 0.95).toFixed(1)}">${esc(l || "\u00a0")}</tspan>`
          : `<tspan x="${bx + pad}" dy="${lh}">${esc(l || "\u00a0")}</tspan>`,
      )
      .join("");

    parts.push(
      `<g${doc.at(m.at)}>` +
        `<rect x="${bx.toFixed(1)}" y="${cy}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="9" fill="${fill}" stroke="${stroke}"/>` +
        `<text font-family="${SANS}" font-size="${font}" fill="${colour}">${tspans}</text>` +
        `</g>`,
    );
    cy += bh + gap;
  }

  return { height: cy - gap, body: parts.join("\n    ") };
}

function logPanel(doc, { font, lh, cols }) {
  const parts = [];
  const cursorStops = [];
  let cy = font;

  LOG.forEach((line) => {
    const seg = line.sep ? [[" " + "\u2500".repeat(cols), COL.edgeSoft]] : line.seg;
    const tspans = seg
      .map((s) => `<tspan fill="${s[1]}">${esc(s[0])}</tspan>`)
      .join("");
    parts.push(
      `<text${doc.at(line.at, { slide: 3, dur: 0.25 })} x="0" y="${cy.toFixed(1)}" xml:space="preserve" ` +
        `font-family="${MONO}" font-size="${font}">${tspans}</text>`,
    );
    if (line.at >= 0) cursorStops.push({ at: line.at, y: cy });
    cy += lh;
  });

  // A block cursor that hops to wherever the next line is about to land. It is
  // the cheapest possible signal that this is a live tail and not a screenshot.
  const first = cursorStops[0];
  let cur = "";
  if (first) {
    const steps = [`0%{transform:translateY(0)}`];
    for (let i = 0; i < cursorStops.length; i++) {
      const next = cursorStops[i + 1];
      const dy = (next ? next.y : cursorStops[i].y + lh) - first.y;
      const pct = ((cursorStops[i].at / T) * 100).toFixed(3);
      steps.push(`${pct}%{transform:translateY(${dy.toFixed(1)}px)}`);
    }
    doc.kf.push(`@keyframes cursor{${steps.join("")}}`);
    doc.kf.push(`@keyframes blink{0%,49%{opacity:.85}50%,100%{opacity:0}}`);
    cur =
      `<g style="animation:cursor ${T}s infinite step-end">` +
      `<rect x="2" y="${(first.y - font + 1.5).toFixed(1)}" width="${(font * 0.6).toFixed(1)}" height="${font.toFixed(1)}" ` +
      `fill="${COL.green}" style="animation:blink 1.05s infinite"/></g>`;
  }

  return { height: cy - lh + 6, body: parts.join("\n    ") + "\n    " + cur };
}

// ---------------------------------------------------------------------------
// Document chrome
// ---------------------------------------------------------------------------

function windowChrome(title, width, height, { accent = COL.dim } = {}) {
  const dots = ["#ff5f57", "#febc2e", "#28c840"]
    .map((c, i) => `<circle cx="${16 + i * 14}" cy="15" r="4.5" fill="${c}" opacity="0.85"/>`)
    .join("");
  return (
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="11" fill="${COL.card}" stroke="${COL.edge}"/>` +
    dots +
    `<text x="${width / 2}" y="19" text-anchor="middle" font-family="${MONO}" font-size="11" fill="${accent}">${esc(title)}</text>` +
    `<line x1="0" y1="31" x2="${width}" y2="31" stroke="${COL.edgeSoft}"/>`
  );
}

// A hairline that fills over one cycle, so a reader knows it loops rather than
// wondering whether it has frozen.
function progressBar(doc, width, height) {
  doc.kf.push(`@keyframes sweep{0%{transform:scaleX(0)}100%{transform:scaleX(1)}}`);
  return (
    `<rect x="0" y="${height - 3}" width="${width}" height="2" fill="${COL.edgeSoft}"/>` +
    `<rect x="0" y="${height - 3}" width="${width}" height="2" fill="${COL.blue}" opacity="0.8" ` +
    `style="animation:sweep ${T}s linear infinite;transform-origin:0 0"/>`
  );
}

function document_(width, height, title, desc, kf, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d">\n` +
    `  <title id="t">${esc(title)}</title>\n` +
    `  <desc id="d">${esc(desc)}</desc>\n` +
    `  <style><![CDATA[\n    ${kf.join("\n    ")}\n  ]]></style>\n` +
    `  ${body}\n</svg>\n`
  );
}

// ---------------------------------------------------------------------------
// The three builds
// ---------------------------------------------------------------------------

const DESC =
  "A replay of the run in docs/FINDINGS.md section 13: a Teams message starts a " +
  "Copilot turn, seven tools are auto-approved, the agent asks a question, the turn " +
  "parks for 48.5 seconds while the user is away, the reply 'lets do #1' is routed as " +
  "an answer rather than a new prompt, and the turn completes in 91.7 seconds.";

function buildThread() {
  const doc = newDoc();
  const width = 470;
  const inner = width - 32;
  const chat = chatPanel(doc, { width: inner, font: 13, lh: 17, chars: 40 });
  const height = Math.round(chat.height + 31 + 26 + 16);
  const body =
    windowChrome("Teams  \u00b7  #copilot-bridge  \u00b7  one thread", width, height, { accent: COL.blue }) +
    `\n  <g transform="translate(16,47)">\n    ${chat.body}\n  </g>\n  ` +
    progressBar(doc, width, height);
  return document_(width, height, "Driving Copilot from a Teams thread", DESC, doc.kf, body);
}

function buildLog() {
  const doc = newDoc();
  const width = 500;
  const font = 12.5;
  const log = logPanel(doc, { font, lh: 17, cols: Math.floor((width - 30) / (font * 0.6)) });
  const height = Math.round(log.height + 31 + 26 + 12);
  const body =
    windowChrome("tmux \u00b7 bridge \u2014 npm run bridge", width, height, { accent: COL.green }) +
    `\n  <g transform="translate(14,46)">\n    ${log.body}\n  </g>\n  ` +
    progressBar(doc, width, height);
  return document_(width, height, "The bridge log for one Teams turn", DESC, doc.kf, body);
}

function buildSplit() {
  const doc = newDoc();
  const width = 820;
  const chatW = 336;
  const logFont = 11;
  const chat = chatPanel(doc, { width: chatW, font: 11.5, lh: 15, chars: 42 });
  const divX = chatW + 46;
  const log = logPanel(doc, {
    font: logFont,
    lh: 15.4,
    cols: Math.floor((width - divX - 44) / (logFont * 0.6)),
  });
  const inner = Math.max(chat.height, log.height);
  const height = Math.round(inner + 31 + 30 + 22);

  const body =
    windowChrome(
      "what you see  \u2502  what actually happens",
      width,
      height,
      { accent: COL.white },
    ) +
    `\n  <line x1="${divX}" y1="38" x2="${divX}" y2="${height - 14}" stroke="${COL.edgeSoft}"/>` +
    `\n  <text x="16" y="46" font-family="${MONO}" font-size="10" fill="${COL.blue}">on your phone</text>` +
    `\n  <text x="${divX + 22}" y="46" font-family="${MONO}" font-size="10" fill="${COL.green}">on the box, same 24 seconds</text>` +
    `\n  <g transform="translate(16,60)">\n    ${chat.body}\n  </g>` +
    `\n  <g transform="translate(${divX + 22},72)">\n    ${log.body}\n  </g>\n  ` +
    progressBar(doc, width, height);

  return document_(width, height, "Code from Teams \u2014 one turn, both sides", DESC, doc.kf, body);
}

const ALL = process.argv.includes("--all");

fs.mkdirSync(OUT, { recursive: true });
const files = {
  "demo-thread.svg": buildThread(),
  ...(ALL ? { "demo-split.svg": buildSplit(), "demo-log.svg": buildLog() } : {}),
};
for (const [name, svg] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), svg);
  console.log(`${name.padEnd(18)} ${(svg.length / 1024).toFixed(1)} KB`);
}
