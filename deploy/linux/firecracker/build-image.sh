#!/usr/bin/env bash
# Builds the kernel and initramfs that ai-ders-mailparse-fc@.service and ai-ders-docparse-fc@.service
# each boot fresh per item: no disk, no network device, just this host's own /opt/ai-ders copied in
# and the four vsock modules ai_ders.vmguest loads. One shared image for both: it's the same venv
# either way, so the only per-content difference is which of two tiny /init-* scripts runs, picked at
# boot by ai_ders.vmhost's `rdinit=` boot arg. Run as root on the server, after `dnf install firecracker
# kernel-devel-$(uname -r)`. install.sh runs it on every install, because the image is a snapshot: it
# carries its own copy of /opt/ai-ders (so a deploy without a rebuild leaves the VMs on the old parser
# and the old Pillow) and of the running kernel (so a host kernel update only reaches the guests once
# this runs again). The guest's kernel and its four modules always come from the same build, so they
# always match each other, whatever the host boots later.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

KERNEL=$(uname -r)
SRC="/usr/src/kernels/$KERNEL"
OUT=/var/lib/ai-ders-firecracker
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

[[ -d $SRC ]] || { echo "no $SRC: install kernel-devel-$KERNEL" >&2; exit 1; }
command -v firecracker >/dev/null || { echo "firecracker not found: dnf install firecracker" >&2; exit 1; }

echo "==> kernel: extracting vmlinux from the running kernel's vmlinuz"
install -d -m 755 "$OUT"
"$SRC/scripts/extract-vmlinux" "/boot/vmlinuz-$KERNEL" >"$OUT/vmlinux.new"
mv "$OUT/vmlinux.new" "$OUT/vmlinux"

echo "==> staging the initramfs"
ROOT="$WORK/root"
install -d -m 755 "$ROOT/opt" "$ROOT/dev" "$ROOT/lib64" "$ROOT/lib/modules.fc"

# The four modules ai_ders.vmguest loads, in modinfo's dependency order. Decompressed: finit_module()
# needs a plain .ko, and module signature enforcement is off by default for this kernel anyway
# (CONFIG_MODULE_SIG_FORCE is not set), so an unsigned extracted module still loads.
MODULES_DIR="/lib/modules/$KERNEL/kernel"
declare -A MODULE_SRC=(
  [virtio_mmio.ko]="drivers/virtio/virtio_mmio.ko.xz"
  [vsock.ko]="net/vmw_vsock/vsock.ko.xz"
  [vmw_vsock_virtio_transport_common.ko]="net/vmw_vsock/vmw_vsock_virtio_transport_common.ko.xz"
  [vmw_vsock_virtio_transport.ko]="net/vmw_vsock/vmw_vsock_virtio_transport.ko.xz"
)
for dst in "${!MODULE_SRC[@]}"; do
  xz -dc "$MODULES_DIR/${MODULE_SRC[$dst]}" >"$ROOT/lib/modules.fc/$dst"
done

# Only what the parsers run, at the same paths as on the host: the package (the venv's ai_ders.pth
# points at /opt/ai-ders), the venv (imap_tools, Pillow, pypdf) and the interpreter it links to. An
# allowlist on purpose: copying all of /opt/ai-ders and deleting known names once carried other files
# into the image - a deploy never removes files it has stopped sending - where untrusted mail runs,
# and this file is world-readable so the service's throwaway user can boot it.
install -d -m 755 "$ROOT/opt/ai-ders"
for part in ai_ders .venv python; do
  cp -a "/opt/ai-ders/$part" "$ROOT/opt/ai-ders/$part"
done
find "$ROOT/opt/ai-ders" -depth -name __pycache__ -exec rm -rf {} +

# uv writes its links as absolute paths (python/cpython-3.12-... -> /opt/ai-ders/python/cpython-3.12.16-...,
# .venv/bin/python -> /opt/ai-ders/python/...). cp -a keeps them verbatim, so seen from the host they
# point out of this copy and back at the live install: an earlier version of the trim below deleted
# files from production that way. Rewrite each one as relative (-s: lexically, without following the
# very links being fixed) so the copy is self-contained, here and in the booted guest alike.
while IFS= read -r -d '' link; do
  target=$(readlink "$link")
  [[ $target == /opt/ai-ders/* ]] || continue
  ln -sfn "$(realpath -sm --relative-to="$(dirname "$link")" "$ROOT$target")" "$link"
done < <(find "$ROOT/opt/ai-ders" -type l -print0)

# Trim the bundled interpreter itself: none of this is reachable from mailparse.py or docparse.py
# (checked with grep for tkinter/lib2to3/idlelib imports - none), so it's pure unreached attack
# surface and boot-time weight. share/terminfo alone is 12M for a guest with no terminal. The guard
# is belt and braces on top of the rewrite above: nothing below may touch a path outside the copy.
STAGE=$(realpath -e "$ROOT")
PY_ROOT=$(realpath -e "$ROOT/opt/ai-ders/python/cpython-3.12-linux-x86_64-gnu")
[[ $PY_ROOT == "$STAGE"/* ]] || { echo "refusing to trim: $PY_ROOT is outside $STAGE" >&2; exit 1; }
rm -rf "$PY_ROOT"/share/terminfo "$PY_ROOT"/share/man "$PY_ROOT"/include
rm -f "$PY_ROOT"/lib/libtcl9*.so "$PY_ROOT"/lib/python3.12/lib-dynload/_tkinter*.so
rm -rf "$PY_ROOT"/lib/{tcl9,tcl9.0,tk9.0,itcl4.3.8,thread3.0.6,pkgconfig}
rm -rf "$PY_ROOT"/lib/python3.12/{tkinter,idlelib,lib2to3,turtledemo,ensurepip,config-3.12-x86_64-linux-gnu}
rm -f "$PY_ROOT"/bin/{pip,pip3,pip3.12,2to3-3.12,idle3.12,pydoc3.12}
rm -rf "$PY_ROOT"/lib/python3.12/site-packages/pip "$PY_ROOT"/lib/python3.12/site-packages/pip-*.dist-info

# Everything the venv's python and Pillow's C extensions are dynamically linked against (checked with
# ldd; pypdf is pure Python, no extra libs of its own), plus libseccomp for ai_ders.vmguest's syscall
# filter. Pillow's own bundled libraries (PIL/../pillow.libs/) already travelled with the cp -a above.
# Several of these (libseccomp.so.2, libz.so.1, ...) are themselves symlinks to a versioned file on
# this distro; cp -a alone would copy just the symlink and leave it dangling, so the real target is
# copied too and the symlink recreated.
for lib in ld-linux-x86-64.so.2 libc.so.6 libpthread.so.0 libdl.so.2 libutil.so.1 libm.so.6 \
  librt.so.1 libz.so.1 libseccomp.so.2; do
  src="/lib64/$lib"
  if [[ -L $src ]]; then
    target=$(readlink -f "$src")
    cp -a "$target" "$ROOT/lib64/$(basename "$target")"
    ln -s "$(basename "$target")" "$ROOT/lib64/$lib"
  else
    cp -a "$src" "$ROOT/lib64/"
  fi
done

mknod -m 622 "$ROOT/dev/console" c 5 1
mknod -m 666 "$ROOT/dev/null" c 1 3
mknod -m 666 "$ROOT/dev/urandom" c 1 9

# Shebang scripts, not `-m ai_ders.fcguest`/`-m ai_ders.dpguest`: Linux only passes a shebang's
# interpreter line through as one argv entry, so flags have to be bundled ("-IB", not "-I -B") and
# the module can't be named on the same line. Invoked via the .venv symlink (not the real interpreter
# path it points to) so CPython finds .venv/pyvenv.cfg and puts the venv's site-packages on sys.path,
# just like the host's own systemd units do. Two entrypoints, not one /init: ai_ders.vmhost picks
# between them with `rdinit=` so a mail VM never even imports ai_ders.dpguest, and vice versa.
cat >"$ROOT/init-mail" <<'EOF'
#!/opt/ai-ders/.venv/bin/python -IB
from ai_ders.fcguest import main
main()
EOF
cat >"$ROOT/init-doc" <<'EOF'
#!/opt/ai-ders/.venv/bin/python -IB
from ai_ders.dpguest import main
main()
EOF
chmod 755 "$ROOT/init-mail" "$ROOT/init-doc"

echo "==> packing initramfs"
(cd "$ROOT" && find . -print0 | cpio --null -o -H newc 2>/dev/null | gzip -1) >"$OUT/initramfs.cpio.gz.new"
mv "$OUT/initramfs.cpio.gz.new" "$OUT/initramfs.cpio.gz"
chown -R root:root "$OUT"
chmod 644 "$OUT"/vmlinux "$OUT"/initramfs.cpio.gz

du -sh "$OUT/vmlinux" "$OUT/initramfs.cpio.gz"
echo "==> done: restart ai-ders-mailparse-fc.socket and ai-ders-docparse-fc.socket if already running"
