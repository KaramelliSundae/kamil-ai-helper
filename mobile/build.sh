#!/usr/bin/env bash
# Builds the release APK on a Linux machine with the Android SDK. Stops by itself if free memory runs low,
# so a shared machine is never squeezed. Run from anywhere: mobile/build.sh
set -uo pipefail

# Android Studio's JDK: the system one is too new for this Gradle. IPv4 is forced because DNS returns
# IPv6 addresses and this machine has no IPv6 route, which fails large downloads.
export JAVA_HOME=${JAVA_HOME:-$HOME/android-studio/jbr} ANDROID_HOME=${ANDROID_HOME:-$HOME/Android/Sdk} NODE_ENV=production
export GRADLE_OPTS="-Djava.net.preferIPv4Stack=true"

# Every build gets a higher versionCode (minutes since 1970), so the phone accepts it as an update.
export AI_DERS_VERSION_CODE=$(( $(date +%s) / 60 ))

cd "$(dirname "$0")"
nice -n 15 npx expo prebuild -p android --no-install 2>&1 | tail -4
cd android
# arm64 for phones, x86_64 so the very same APK can be tested on an emulator.
nice -n 15 ./gradlew assembleRelease --no-daemon --max-workers=4 -PreactNativeArchitectures=arm64-v8a,x86_64 \
  "-Dorg.gradle.jvmargs=-Xmx2500m -XX:MaxMetaspaceSize=768m -Djava.net.preferIPv4Stack=true" \
  -Pkotlin.daemon.jvmargs=-Xmx1500m &
build=$!
while kill -0 "$build" 2>/dev/null; do
  free=$(awk '/MemAvailable/{print int($2/1048576)}' /proc/meminfo)
  if [ "$free" -lt 2 ]; then
    echo "STOPPED: only ${free} GiB free"
    pkill -TERM -P "$build"
    kill "$build"
    wait "$build"
    echo BUILD-STOPPED
    exit 3
  fi
  sleep 5
done
wait "$build"
rc=$?
echo "BUILD-DONE rc=$rc"
ls -la --block-size=M app/build/outputs/apk/release/ 2>/dev/null | tail -3
exit $rc
