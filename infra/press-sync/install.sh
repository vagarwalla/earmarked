#!/usr/bin/env bash
#
# press — install (or reinstall) the half-hourly sync agent.
#
# Fills the repo path and node location into the plist template, drops it in
# ~/Library/LaunchAgents, and loads it. Re-running is how you update it after
# moving the repo or changing node.
#
#   bash infra/press-sync/install.sh
#
# To stop it:      launchctl bootout gui/$UID/com.vaidehi.press-sync
# To see it:       launchctl print gui/$UID/com.vaidehi.press-sync | head
# To watch it:     tail -f .press/sync.log

set -euo pipefail

LABEL=com.vaidehi.press-sync
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="$REPO/infra/press-sync/$LABEL.plist"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  echo "install: no node on PATH" >&2
  exit 1
fi

# The agent runs with the repo as its working directory and reads .env.local
# from there, so both must exist before it is worth loading.
[ -f "$REPO/.env.local" ] || { echo "install: $REPO/.env.local is missing" >&2; exit 1; }
[ -d "$REPO/.press" ] || { echo "install: $REPO/.press is missing — run press-run first" >&2; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$REPO/.press"

sed -e "s|__REPO__|$REPO|g" \
    -e "s|__NODE__|$NODE|g" \
    -e "s|__NODEDIR__|$(dirname "$NODE")|g" \
    "$TEMPLATE" > "$TARGET"

# bootout first so a re-run replaces cleanly rather than erroring on a
# already-loaded label.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$TARGET"

echo "installed $LABEL"
echo "  repo:  $REPO"
echo "  node:  $NODE"
echo "  every: 30 minutes, plus on login and wake"
echo "  log:   $REPO/.press/sync.log"
