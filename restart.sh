#!/usr/bin/env bash
# Dewey 2.0: pull latest, build, and swap the new build in.
# Safe to run from anywhere — it operates on its own directory.
#
# The build goes into .next-build, so the running app keeps its current .next
# until a new build succeeds. If the build fails, the app is left alone.
#
# Restart strategy:
#   - If a systemd --user service named "dewey2" exists, restart that.
#   - Otherwise fall back to a backgrounded `next start`, logging to dewey.log
#     and recording the PID in dewey.pid.
#
# Port comes from .env (PORT=...), defaulting to 3000.

set -euo pipefail
cd "$(dirname "$0")"

BUILD_DIR=.next-build

# --- Load PORT from .env (without leaking other secrets into the log) ---
PORT=3000
if [ -f .env ]; then
  ENV_PORT="$(grep -E '^[[:space:]]*PORT=' .env | tail -n1 | cut -d= -f2- | tr -d '[:space:]')"
  [ -n "${ENV_PORT:-}" ] && PORT="$ENV_PORT"
fi

echo "→ git pull"
git pull --ff-only

# npm writes node_modules/.package-lock.json when an install finishes, so this
# also catches a missing or interrupted install.
if [ ! -e node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "→ npm ci"
  npm ci
else
  echo "→ Dependencies unchanged, skipping npm ci"
fi

echo "→ Building into $BUILD_DIR"
rm -rf "$BUILD_DIR"
if ! NEXT_DIST_DIR="$BUILD_DIR" npm run build; then
  rm -rf "$BUILD_DIR"
  echo "Build failed. The running app and its current build were left alone." >&2
  exit 1
fi

HAS_SERVICE=false
if command -v systemctl >/dev/null 2>&1 && systemctl --user cat dewey2 >/dev/null 2>&1; then
  HAS_SERVICE=true
fi

if [ "$HAS_SERVICE" = true ]; then
  echo "→ Stopping dewey2"
  systemctl --user stop dewey2
fi

echo "→ Freeing port $PORT"
# lsof is the most portable way to find the listener (works on macOS + Linux).
if command -v lsof >/dev/null 2>&1; then
  lsof -ti tcp:"$PORT" | xargs kill -9 2>/dev/null || true
elif command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
fi
sleep 1

echo "→ Swapping in the new build"
rm -rf .next
mv "$BUILD_DIR" .next

if [ "$HAS_SERVICE" = true ]; then
  echo "→ Starting via systemd --user (dewey2)"
  systemctl --user start dewey2
  echo "Done. Check: systemctl --user status dewey2"
else
  echo "→ Starting via next start on port $PORT"
  # Detach so the service keeps running after this script exits.
  nohup env PORT="$PORT" npm run start -- -p "$PORT" >dewey.log 2>&1 &
  echo $! >dewey.pid
  echo "Done. PID $(cat dewey.pid), logging to dewey.log"
fi
