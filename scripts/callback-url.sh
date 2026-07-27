#!/usr/bin/env bash
# Print the exact callback URL to paste into the Teams outgoing webhook.
#
# There is no devtunnel command that prints just the URL, and the one thing you
# must not do is hand-assemble it from a template - a wrong callback URL is
# silent, the webhook simply never reaches the bridge.
#
# Usage: scripts/callback-url.sh [tunnel-id] [port]
set -euo pipefail

TUNNEL="${1:-teams-bridge}"
PORT="${2:-3978}"
DEVTUNNEL="${DEVTUNNEL:-$HOME/bin/devtunnel}"
PATH_SUFFIX="/api/messages"

if [ ! -x "$DEVTUNNEL" ]; then
  command -v devtunnel >/dev/null 2>&1 && DEVTUNNEL="$(command -v devtunnel)" || {
    echo "devtunnel not found at $DEVTUNNEL and not on PATH." >&2
    echo "Ubuntu's ~/.profile only adds ~/bin if it existed at login - try:" >&2
    echo "  export PATH=\"\$HOME/bin:\$PATH\"" >&2
    exit 1
  }
fi

# A port URL carries the port in its hostname, e.g. https://abc123-3978.region...
# Matching on that is what stops us returning the tunnel's own management URL.
pattern="https://[A-Za-z0-9.-]*-${PORT}\.[A-Za-z0-9.-]*devtunnels\.ms"

raw=""
for cmd in \
  "$DEVTUNNEL port show $TUNNEL -p $PORT -j" \
  "$DEVTUNNEL show $TUNNEL -j" \
  "$DEVTUNNEL show $TUNNEL"
do
  # Capture output even on failure - the error text is what tells the user
  # whether this is a sign-in problem or a wrong tunnel id.
  out="$($cmd 2>&1)" || true
  [ -n "$out" ] && raw="$out"
  url="$(printf '%s' "$out" | grep -oE "$pattern" | head -1 || true)"
  [ -n "$url" ] && { echo "${url}${PATH_SUFFIX}"; exit 0; }
done

echo "Could not find a port URL for tunnel '$TUNNEL' port $PORT." >&2
if printf '%s' "$raw" | grep -qiE "login required|not logged in|authenticate|unauthorized"; then
  echo "You are not signed in. Run: $DEVTUNNEL user login -b -e" >&2
elif [ -z "$raw" ]; then
  echo "devtunnel produced no output - is the tunnel id right? Try: $DEVTUNNEL list" >&2
else
  echo "Last output was:" >&2
  printf '%s\n' "$raw" >&2
fi
exit 1
