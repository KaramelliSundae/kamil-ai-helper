#!/usr/bin/env bash
# Copies the project to the server over SSH and installs it. Run on your computer, in this repository.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
# The server as user@host: the first argument, or a one-line deploy/.host file (kept out of git).
host=${1:-$(cat "$here/deploy/.host" 2>/dev/null || true)}
[[ -n $host ]] || { echo "usage: deploy/deploy.sh user@server (or put user@server in deploy/.host)" >&2; exit 1; }

ssh "$host" sudo install -d -m 755 /opt/ai-ders
rsync -rlt --delete --rsync-path="sudo rsync" \
  --exclude .git --exclude .venv --exclude python --exclude .uv-cache --exclude __pycache__ \
  --exclude .pytest_cache --exclude .state --exclude tests --exclude mobile --exclude benchmarks \
  --exclude .DS_Store --exclude 'client_secret*.json' --exclude .host \
  "$here/" "$host:/opt/ai-ders/"
# -t: the installer may ask for the API address, and sudo for a password.
ssh -t "$host" sudo bash /opt/ai-ders/deploy/linux/install.sh
