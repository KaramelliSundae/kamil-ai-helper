#!/usr/bin/env bash
# Offers the APK from build.sh to phones in server mode as an update ("Güncelle" in the app).
# Run on the server, once the build has been tested: mobile/publish.sh
set -euo pipefail

apk=$(cd "$(dirname "$0")" && pwd)/android/app/build/outputs/apk/release/app-release.apk
badging=$("$(ls -d "$HOME"/Android/Sdk/build-tools/* | tail -1)/aapt2" dump badging "$apk")
code=$(sed -nE "s/.*versionCode='([0-9]+)'.*/\1/p" <<<"$badging")
name=$(sed -nE "s/.*versionName='([^']+)'.*/\1/p" <<<"$badging")
dir=/var/lib/ai-ders/app

sudo install -d -o ai-ders -g ai-ders -m 750 "$dir"
# The APK goes first and the version file last, so the phone never sees a version without its file.
sudo install -o ai-ders -g ai-ders -m 640 "$apk" "$dir/ai-ders.apk.new"
sudo mv "$dir/ai-ders.apk.new" "$dir/ai-ders.apk"
printf '{"versionCode": %s, "versionName": "%s", "sha256": "%s", "size": %s}\n' \
  "$code" "$name" "$(sha256sum "$apk" | cut -d' ' -f1)" "$(stat -c %s "$apk")" \
  | sudo install -o ai-ders -g ai-ders -m 640 /dev/stdin "$dir/latest.json.new"
sudo mv "$dir/latest.json.new" "$dir/latest.json"
echo "published $name ($code)"
