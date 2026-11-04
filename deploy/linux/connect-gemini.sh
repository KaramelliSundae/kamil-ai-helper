#!/usr/bin/env bash
# Connects Gemini for Kamil's "Gemini" mode. Run on the server:
#   ssh -t you@your-server sudo /opt/ai-ders/deploy/linux/connect-gemini.sh
# Asks for an API key from aistudio.google.com, checks it, picks the newest Flash model and stores the key
# encrypted on this machine. On the free tier Google may use the prompts for training; school mail
# is never sent either way, because Gemini mode has no mail tools.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
# Encrypted to the TPM when the machine has one, otherwise to the host key under /var/lib/systemd.
# No PCR binding: a firmware update must not lock the server out of its own secrets.
if [[ -e /dev/tpmrm0 ]]; then key_args=(--with-key=host+tpm2 --tpm2-pcrs=); else key_args=(--with-key=host); fi
read -rsp "Gemini API anahtarı (görünmez): " key
echo
[[ -n "$key" ]] || { echo "anahtar boş" >&2; exit 1; }

# The key goes in a header from stdin, never in a URL or a process argument.
models=$(printf 'x-goog-api-key: %s\n' "$key" \
  | curl -sf -m 20 -H @- "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000") \
  || { echo "Google bu anahtarı kabul etmedi" >&2; exit 1; }
model=$(python3 -I -c '
import json, re, sys
names = [m["name"].removeprefix("models/") for m in json.load(sys.stdin).get("models", [])
         if "generateContent" in m.get("supportedGenerationMethods", [])]
def version(name):
    match = re.fullmatch(r"gemini-(\d+(?:\.\d+)?)-flash", name)
    return float(match.group(1)) if match else None
stable = sorted((n for n in names if version(n) is not None), key=version)
print(stable[-1] if stable else "gemini-flash-latest")
' <<<"$models")
echo "Model: $model"

printf '%s' "$key" | systemd-creds encrypt --name=gemini_key "${key_args[@]}" - \
  /etc/ai-ders/creds/gemini_key.cred
chmod 600 /etc/ai-ders/creds/gemini_key.cred
if grep -q '^GEMINI_MODEL=' /etc/ai-ders/env; then
  sed -i "s/^GEMINI_MODEL=.*/GEMINI_MODEL=$model/" /etc/ai-ders/env
else
  printf '# Picked by connect-gemini.sh.\nGEMINI_MODEL=%s\n' "$model" >> /etc/ai-ders/env
fi

# A drop-in, because the API unit must also start without this credential.
install -d /etc/systemd/system/ai-ders-api.service.d
printf '[Service]\nLoadCredentialEncrypted=gemini_key:/etc/ai-ders/creds/gemini_key.cred\n' \
  > /etc/systemd/system/ai-ders-api.service.d/gemini.conf
command -v restorecon >/dev/null && restorecon -R /etc/systemd/system/ai-ders-api.service.d /etc/ai-ders/env
systemctl daemon-reload
systemctl restart ai-ders-api.service
echo "Gemini bağlandı. Uygulamada Sohbet'in üstündeki model seçiciden Gemini'yi seç."
