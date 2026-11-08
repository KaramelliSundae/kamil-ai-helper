"""Host-side launcher for the Firecracker-backed mail sandbox, `python3 -I -B -m ai_ders.fchost`.

Started once per connection by systemd socket activation, exactly like `ai_ders.mailparse` itself
(deploy/linux/ai-ders-mailparse-fc@.service mirrors ai-ders-mailparse@.service): raw mail bytes in on
stdin, JSON out on stdout, then it exits. `ai_ders.mailparse.SandboxedParser` already speaks this
contract, so pointing `MAIL_PARSER_SOCKET` at this unit's socket instead of the systemd-sandbox one is
the only change needed on the watcher side.

The actual machinery (the Firecracker API client, the vsock protocol, process teardown) is shared
with every other content type in ai_ders/vmhost.py; this file is just that machinery pointed at the
mail guest (/init-mail, run by ai_ders/fcguest.py) with mail-sized budgets.
"""

from __future__ import annotations

import json
import os
import sys

from .mailparse import MAX_INPUT_BYTES, MAX_REPLY_BYTES
from .vmhost import run_vm

# Guest RAM, which has to hold the unpacked initramfs (it stays resident as the root filesystem) as
# well as the parser's own 384 MiB: measured, a value too small to unpack into corrupts the unpack
# instead of failing cleanly ("Initramfs unpacking failed: write error", or /init failing with
# ETXTBSY). It's charged to ai-ders-mailparse-fc@.service's cgroup, whose MemoryMax must stay above it.
MEM_SIZE_MIB = 768
REPLY_TIMEOUT = 35.0  # a little over ai_ders.fcguest's own 30-second wall-clock budget
IMAGE_DIR = os.environ.get("AI_DERS_FC_IMAGES", "/var/lib/ai-ders-firecracker")


def main() -> None:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        reply = b'{"error": "too large"}'
    else:
        try:
            reply = run_vm(
                raw, kernel_dir=IMAGE_DIR, rdinit="/init-mail", mem_size_mib=MEM_SIZE_MIB,
                reply_timeout=REPLY_TIMEOUT, max_reply_bytes=MAX_REPLY_BYTES,
            ) or json.dumps({"error": "FirecrackerNoReply"}).encode()
        except Exception as error:  # noqa: BLE001 - report, never raise into a traceback
            # To the journal: after BOOT_ATTEMPTS failed boots this mail is stored as unreadable, and
            # the reason should be findable (journalctl -u 'ai-ders-mailparse-fc@*').
            print(f"fchost: {type(error).__name__}: {error}", file=sys.stderr)
            reply = json.dumps({"error": type(error).__name__}).encode()
    sys.stdout.buffer.write(reply)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
