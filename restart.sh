#!/usr/bin/env bash
# Dewey 2.0: pull latest, clean build, and restart the app.
# Safe to run from anywhere — it operates on its own directory.
#
# Restart strategy:
#   - If a systemd --user service named "dewey2" exists, restart that.
#   - Otherwise fall back to a backgrounded `next start`, logging to dewey.log
#     and recording the PID in dewey.pid.
#
# Port comes from .env (PORT=...), defaulting to 3000.

set -euo pipefail
cd "$(dirname "$0")"

# --- Load PORT from .env (without leaking other secrets into the log) ---
PORT=3000
if [ -f .env ]; then
  ENV_PORT="$(grep -E '^[[:space:]]*PORT=' .env | tail -n1 | cut -d= -f2- | tr -d '[:space:]')"
  [ -n "${ENV_PORT:-}" ] && PORT="$ENV_PORT"
fi

echo "→ git pull"
git pull --ff-only

echo "→ Freeing port $PORT"
# lsof is the most portable way to find the listener (works on macOS + Linux).
if command -v lsof >/dev/null 2>&1; then
  lsof -ti tcp:"$PORT" | xargs kill -9 2>/dev/null || true
elif command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
fi
sleep 1

echo "→ Clean build"
rm -rf .next
npm ci
npm run build

if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files 2>/dev/null | grep -q '^dewey2\.service'; then
  echo "→ Restarting via systemd --user (dewey2)"
  systemctl --user restart dewey2
  echo "Done. Check: systemctl --user status dewey2"
else
  echo "→ Starting via next start on port $PORT"
  # Detach so the service keeps running after this script exits.
  nohup env PORT="$PORT" npm run start -- -p "$PORT" >dewey.log 2>&1 &
  echo $! >dewey.pid
  echo "Done. PID $(cat dewey.pid), logging to dewey.log"
fi
