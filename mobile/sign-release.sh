#!/usr/bin/env bash
# Signs the APK from build.sh with your own release key, for sharing it (for example as a GitHub release):
#   mobile/sign-release.sh kamil-0.2.0.apk
# build.sh signs with React Native's debug key, which ships with every React Native project, so a phone
# would accept anyone's "update" over such a build. A private key means only you can publish updates.
# The key is created on first use in ~/.config/kamil-release (KAMIL_RELEASE_DIR). Back that folder up:
# with a lost key, people have to uninstall before they can install your next version.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: mobile/sign-release.sh out.apk}
dir=${KAMIL_RELEASE_DIR:-$HOME/.config/kamil-release}
keystore=$dir/kamil-release.jks
password=$dir/password
tools=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/* | tail -1)
keytool=${JAVA_HOME:-$HOME/android-studio/jbr}/bin/keytool

if [[ ! -f $keystore ]]; then
  install -d -m 700 "$dir"
  (umask 077; head -c 32 /dev/urandom | base64 | tr -d '\n/+=' >"$password")
  "$keytool" -genkeypair -keystore "$keystore" -storetype PKCS12 -alias kamil -keyalg RSA -keysize 4096 \
    -validity 36500 -dname "CN=Kamil" -storepass:file "$password" -keypass:file "$password"
fi
# A PKCS12 key shares the store's password, so it is given once.
"$tools/apksigner" sign --ks "$keystore" --ks-key-alias kamil --ks-pass file:"$password" --out "$out" \
  "$here/android/app/build/outputs/apk/release/app-release.apk"
rm -f "$out.idsig"
"$tools/apksigner" verify --print-certs "$out" 2>/dev/null | grep -E "certificate (DN|SHA-256)"
sha256sum "$out"
