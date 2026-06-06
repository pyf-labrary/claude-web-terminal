#!/usr/bin/env bash
# Launcher for claude-web-terminal (tmux-backed, login-protected).
#
#   CWT_USER=me CWT_PASS=secret PORT=7531 ./run.sh
#
# Without CWT_PASS it falls back to admin/admin with a loud warning — fine for
# localhost, never for a public deployment.
set -euo pipefail
cd "$(dirname "$0")"

command -v tmux >/dev/null || { echo "tmux is required (apt install tmux / brew install tmux)"; exit 1; }
[ -d node_modules ] || npm install

: "${PORT:=7531}"
: "${HOST:=0.0.0.0}"

exec node server/index.js
