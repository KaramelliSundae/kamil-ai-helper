#!/usr/bin/env bash
# Optional headless test emulator: mobile/emulator.sh <avd-name> "-no-window -gpu swangle"
# Renders on the integrated GPU (Mesa) so a discrete NVIDIA GPU stays free for other work, and stops
# after 20 minutes or when free memory runs low. On some machines only "-gpu swangle" works headless.
export VK_LOADER_LAYERS_DISABLE="~implicit~" __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json __GLX_VENDOR_LIBRARY_NAME=mesa
timeout 1200 nice -n 10 ~/Android/Sdk/emulator/emulator -avd "$1" -no-audio -no-boot-anim $2 -memory 2048 -cores 4 -no-snapshot > /tmp/emu.log 2>&1 &
emu=$!
while kill -0 $emu 2>/dev/null; do
  free=$(awk "/MemAvailable/{print int(\$2/1048576)}" /proc/meminfo)
  if [ "$free" -lt 2 ]; then echo "LOW MEMORY ${free}G, stopping" >> /tmp/emu.log; kill $emu; pkill -x qemu-system-x86; fi
  sleep 3
done
