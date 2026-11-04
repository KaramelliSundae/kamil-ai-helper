#!/usr/bin/env bash
# Stores the Canvas token and mail password, encrypted on this machine. Run on the server:
#   ssh -t you@your-server sudo /opt/ai-ders/deploy/linux/set-secrets.sh
# Press Enter at a prompt to keep the stored value. Nothing is echoed, logged or passed as an argument,
# except the phone's token, which is generated here and shown once so it can be typed into the app.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
# Encrypted to the TPM when the machine has one, otherwise to the host key under /var/lib/systemd.
# No PCR binding: a firmware update must not lock the server out of its own secrets.
if [[ -e /dev/tpmrm0 ]]; then key_args=(--with-key=host+tpm2 --tpm2-pcrs=); else key_args=(--with-key=host); fi

store() {
  local name=$1 prompt=$2 value
  read -rsp "$prompt: " value
  echo
  if [[ -z "$value" ]]; then
    # An empty secret turns that feature off; services still need the file to start.
    [[ -f "/etc/ai-ders/creds/$name.cred" ]] && { echo "  $name unchanged"; return 0; }
    echo "  $name left empty (feature off)"
  fi
  printf '%s' "$value" | systemd-creds encrypt --name="$name" "${key_args[@]}" - \
    "/etc/ai-ders/creds/$name.cred"
  chmod 600 "/etc/ai-ders/creds/$name.cred"
  echo "  $name stored"
}

install -d -m 700 /etc/ai-ders/creds
store canvas_token "Canvas access token"
store mail_password "School mail password (Enter to skip mail)"

if [[ ! -f /etc/ai-ders/creds/api_token.cred ]]; then
  token=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  printf '%s' "$token" | systemd-creds encrypt --name=api_token "${key_args[@]}" - \
    /etc/ai-ders/creds/api_token.cred
  chmod 600 /etc/ai-ders/creds/api_token.cred
  echo
  echo "Phone app token, shown only this once:"
  echo "  $token"
fi
