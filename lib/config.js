// Non-secret bridge settings, kept in a file you edit and reload.
//
// SECRETS DELIBERATELY DO NOT LIVE HERE. TEAMS_WEBHOOK_SECRET and TEAMS_FLOW_URL
// stay in the environment, so there is no file on disk that hands someone the
// bridge if it is copied, backed up, or shown on a screen share.
//
// Precedence: environment variable > config file > default. The env override
// exists for one-off runs; the file is the normal way to change things.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CONFIG_PATH =
  process.env.BRIDGE_CONFIG ?? path.join(__dirname, "..", "bridge.config.json");

const DEFAULTS = {
  repoDir: process.cwd(),
  model: "claude-opus-5",
  effort: "xhigh",
  yolo: true,
  allowedAadIds: [],
};

function readFile() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Loud, not silent. A typo here would otherwise fall back to defaults and
    // point the agent at the wrong repo without ever saying so.
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${e.message}`);
  }
}

function load() {
  const file = readFile();
  const envList = process.env.TEAMS_ALLOWED_AAD_IDS;

  const cfg = {
    repoDir: process.env.REPO_DIR ?? file.repoDir ?? DEFAULTS.repoDir,
    model: process.env.COPILOT_MODEL ?? file.model ?? DEFAULTS.model,
    effort: process.env.COPILOT_EFFORT ?? file.effort ?? DEFAULTS.effort,
    yolo:
      process.env.YOLO !== undefined
        ? process.env.YOLO !== "0"
        : (file.yolo ?? DEFAULTS.yolo),
    allowedAadIds: (envList !== undefined
      ? envList.split(",")
      : (file.allowedAadIds ?? DEFAULTS.allowedAadIds)
    )
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean),
    configPath: fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : null,
  };

  cfg.repoDir = path.resolve(cfg.repoDir.replace(/^~(?=$|\/)/, process.env.HOME));
  return cfg;
}

function git(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// Everything that has to be true before the agent can do useful work in a repo.
// Checked at startup so a missing piece shows up in the banner, not three minutes
// into a turn as a failed commit nobody is watching.
function checkRepo(dir) {
  const problems = [];
  const notes = [];

  if (!fs.existsSync(dir)) {
    problems.push(`repoDir does not exist: ${dir}`);
    return { problems, notes };
  }
  if (!fs.statSync(dir).isDirectory()) {
    problems.push(`repoDir is not a directory: ${dir}`);
    return { problems, notes };
  }
  if (!git(dir, ["rev-parse", "--git-dir"])) {
    problems.push(`repoDir is not a git repository: ${dir}`);
    return { problems, notes };
  }

  // Resolves local, then global, then system. Empty means `git commit` will fail
  // with "Please tell me who you are" - and the global identity is often unset.
  const name = git(dir, ["config", "user.name"]);
  const email = git(dir, ["config", "user.email"]);
  if (!name || !email) {
    problems.push(
      "no git identity for this repo - `git commit` will fail. Fix with:\n" +
        `      git -C ${dir} config user.name "Your Name"\n` +
        `      git -C ${dir} config user.email "you@example.com"`,
    );
  } else {
    notes.push(`commits as ${name} <${email}>`);
  }

  const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch) {
    notes.push(`on branch ${branch}`);
    if (branch === "main" || branch === "master") {
      notes.push(
        `WARNING: yolo agent is on ${branch}. Protect it, or work on a branch.`,
      );
    }
  }

  const remote = git(dir, ["remote", "get-url", "origin"]);
  notes.push(remote ? `origin ${remote}` : "no origin remote - cannot push or open PRs");

  return { problems, notes };
}

module.exports = { load, checkRepo, CONFIG_PATH };
