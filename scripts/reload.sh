#!/usr/bin/env bash
# Make the current bridge.config.json active.
#
# Restarts the bridge process INSIDE its existing tmux window, which matters:
# TEAMS_WEBHOOK_SECRET and TEAMS_FLOW_URL may live only in that shell's
# environment. Starting a fresh shell would lose them.
#
# Restarts via `npm run bridge`, not `node scripts/bridge.js`: the npm script
# carries --env-file-if-exists=.env, and without it a .env-based setup comes
# back up with no secrets and silently no-ops every reply.
#
# Nothing is lost by restarting. Copilot sessions live on disk and are resumed
# by an id derived from the Teams thread, so conversations survive - only a turn
# that happens to be running right now would be interrupted.
#
#   scripts/reload.sh            reload the bridge in tmux session "bridge"
#   BRIDGE_TMUX=other scripts/reload.sh

set -euo pipefail

SESSION="${BRIDGE_TMUX:-bridge}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null; then
  echo "node not found on PATH" >&2
  exit 1
fi

# Fail before touching the running bridge, not after killing it.
node -e "
  const { load, checkRepo } = require('$ROOT/lib/config');
  const c = load();
  const r = checkRepo(c.repoDir);
  console.log('config  ' + (c.configPath ?? '(none - using defaults)'));
  console.log('repo    ' + c.repoDir);
  for (const n of r.notes) console.log('        ' + n);
  if (r.problems.length) {
    for (const p of r.problems) console.error('\n  ✗ ' + p);
    console.error('\nNot reloading. Fix the above first.');
    process.exit(1);
  }
"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo
  echo "No tmux session \"$SESSION\" - the bridge is not running there."
  echo "Start it with:  tmux new -s $SESSION"
  echo "then inside:    cd $ROOT && npm run bridge"
  exit 1
fi

echo
echo "reloading bridge in tmux session \"$SESSION\"..."
tmux send-keys -t "$SESSION" C-c
sleep 2
tmux send-keys -t "$SESSION" "cd $ROOT && npm run bridge" Enter
sleep 6

echo
tmux capture-pane -p -t "$SESSION" | grep -v '^$' | tail -14
