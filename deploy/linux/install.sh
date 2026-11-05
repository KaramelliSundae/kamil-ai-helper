#!/usr/bin/env bash
# Installs or updates the server on this machine. Run by deploy/deploy.sh, as root. Safe to re-run.
set -euo pipefail

root=/opt/ai-ders
here="$root/deploy/linux"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

# uv is usually installed per user, so look where the person who ran sudo keeps it.
uv=""
for candidate in "${UV:-}" "$(command -v uv || true)" "/home/${SUDO_USER:-}/.local/bin/uv" /root/.local/bin/uv /usr/local/bin/uv; do
  [[ -n $candidate && -x $candidate ]] && { uv=$candidate; break; }
done
[[ -n $uv ]] || { echo "uv not found: install it (https://docs.astral.sh/uv/) or set UV=/path/to/uv" >&2; exit 1; }

id ai-ders >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ai-ders

echo "==> syncing Python environment"
chown -R root:root "$root"
# The interpreter stays under /opt because the services run with ProtectHome.
(cd "$root" && UV_PYTHON_INSTALL_DIR="$root/python" UV_CACHE_DIR="$root/.uv-cache" UV_PYTHON_PREFERENCE=only-managed \
  "$uv" sync --frozen --no-dev -q)
rm -rf "$root/.uv-cache"
chmod +x "$here"/*.sh
command -v restorecon >/dev/null && restorecon -R "$root"

echo "==> settings"
install -d -m 755 /etc/ai-ders
install -d -m 700 /etc/ai-ders/creds
[[ -f /etc/ai-ders/env ]] || install -m 644 "$root/deploy/env.example" /etc/ai-ders/env
if [[ -f "$root/deploy/llm.env.example" && ! -f /etc/ai-ders/llm.env ]]; then
  install -m 644 "$root/deploy/llm.env.example" /etc/ai-ders/llm.env
fi
if ! grep -q '^API_HOST=' /etc/ai-ders/env; then
  # The phone's API listens on one private address: Tailscale if present, otherwise ask.
  address=$(tailscale ip -4 2>/dev/null | head -1 || true)
  [[ -n $address ]] || read -rp "Address the API should listen on (this machine's LAN IP): " address
  echo "API_HOST=$address" >>/etc/ai-ders/env
fi
ln -sf "$root/.venv/bin/ai-ders" /usr/local/bin/ai-ders
systemd-creds setup >/dev/null 2>&1 || true

echo "==> services"
shopt -s nullglob
units=("$here"/ai-ders-*.service "$here"/ai-ders-*.socket "$here"/ai-ders-*.timer "$here"/ai-ders-*.path)
for unit in "${units[@]}"; do
  install -m 644 "$unit" "/etc/systemd/system/$(basename "$unit")"
done
# Site-specific drop-ins (deploy/linux/private/<unit>.d/*.conf), if this checkout has any.
for dropins in "$here"/private/*.d; do
  install -d "/etc/systemd/system/$(basename "$dropins")"
  install -m 644 "$dropins"/*.conf "/etc/systemd/system/$(basename "$dropins")/"
done
command -v restorecon >/dev/null && restorecon -R /etc/systemd/system/ai-ders-*
systemctl daemon-reload
systemctl enable --now ai-ders-mailparse.socket
grep -q '^KEEP_AWAKE=yes' /etc/ai-ders/env && systemctl enable --now ai-ders-keepawake.service

if [[ -f /etc/ai-ders/creds/api_token.cred ]]; then
  systemctl enable ai-ders-api.service
  systemctl restart ai-ders-api.service
  echo "==> API running"
fi
if [[ -f /etc/ai-ders/creds/canvas_token.cred ]]; then
  systemctl enable --now ai-ders-watcher.timer ai-ders-watcher.path ai-ders-digest.timer
  echo "==> timers enabled"
else
  echo "==> no secrets yet: run set-secrets.sh, edit /etc/ai-ders/env, then run this again"
fi
