#!/usr/bin/env bash
# Connects Google Tasks once, so the app's "Google Tasks'a ekle" works. Run on the server:
#   ssh -t you@your-server sudo /opt/ai-ders/deploy/linux/connect-google-tasks.sh [client.json]
# With the client JSON downloaded from Google Cloud it reads the ID and secret from it and deletes the
# file afterwards; without it, it asks for both. Then it asks for the address the browser lands on.
# The result is a refresh token for the tasks scope only, encrypted like the others.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
# Encrypted to the TPM when the machine has one, otherwise to the host key under /var/lib/systemd.
# No PCR binding: a firmware update must not lock the server out of its own secrets.
if [[ -e /dev/tpmrm0 ]]; then key_args=(--with-key=host+tpm2 --tpm2-pcrs=); else key_args=(--with-key=host); fi
client_file=${1:-}
if [[ -n $client_file ]]; then
  [[ -f $client_file ]] || { echo "dosya yok: $client_file" >&2; exit 1; }
  # Read by root only while it is needed, then gone, whatever happens.
  trap 'shred -u "$client_file" 2>/dev/null || rm -f "$client_file"' EXIT
  credentials=$(/opt/ai-ders/.venv/bin/ai-ders google-auth --client-file "$client_file")
else
  credentials=$(/opt/ai-ders/.venv/bin/ai-ders google-auth)
fi
printf '%s' "$credentials" | systemd-creds encrypt --name=google_tasks "${key_args[@]}" - \
  /etc/ai-ders/creds/google_tasks.cred
chmod 600 /etc/ai-ders/creds/google_tasks.cred

# A drop-in, because the API unit must also start without this credential.
install -d /etc/systemd/system/ai-ders-api.service.d
printf '[Service]\nLoadCredentialEncrypted=google_tasks:/etc/ai-ders/creds/google_tasks.cred\n' \
  > /etc/systemd/system/ai-ders-api.service.d/google-tasks.conf
command -v restorecon >/dev/null && restorecon -R /etc/systemd/system/ai-ders-api.service.d
systemctl daemon-reload
systemctl restart ai-ders-api.service
echo "Google Tasks bağlandı."
