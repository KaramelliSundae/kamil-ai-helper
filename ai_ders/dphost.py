"""Host-side launcher for the Firecracker-backed document sandbox, `python3 -I -B -m ai_ders.dphost`.

Started once per connection by systemd socket activation, exactly like `ai_ders.docparse` itself
(deploy/linux/ai-ders-docparse-fc.socket mirrors ai-ders-docparse.socket): raw document bytes in on
stdin, JSON out on stdout, then it exits. `ai_ders.docparse.SandboxedDocumentReader` already speaks
this contract, so pointing `DOC_PARSER_SOCKET` at this unit's socket instead of the systemd-sandbox
one is the only change needed on the watcher side.

The actual machinery (the Firecracker API client, the vsock protocol, process teardown) is shared
with every other content type in ai_ders/vmhost.py; this file is just that machinery pointed at the
document guest (/init-doc, run by ai_ders/dpguest.py). No Pillow in this one, so a smaller memory
budget than ai_ders/fchost.py's suffices.
"""

from __future__ import annotations

import json
import os
import sys

from .docparse import MAX_INPUT_BYTES, MAX_REPLY_BYTES
from .vmhost import run_vm

# Guest RAM: the resident root filesystem (~170 MiB unpacked) plus the parser's own 384 MiB address
# space, so a document that hits that limit gets a MemoryError rather than the guest kernel running
# out first. Charged to ai-ders-docparse-fc@.service's cgroup, whose MemoryMax must stay above it.
MEM_SIZE_MIB = 640
REPLY_TIMEOUT = 35.0  # a little over ai_ders.dpguest's own 30-second wall-clock budget
IMAGE_DIR = os.environ.get("AI_DERS_FC_IMAGES", "/var/lib/ai-ders-firecracker")


def main() -> None:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        reply = json.dumps({"text": ""}).encode()
    else:
        try:
            reply = run_vm(
                raw, kernel_dir=IMAGE_DIR, rdinit="/init-doc", mem_size_mib=MEM_SIZE_MIB,
                reply_timeout=REPLY_TIMEOUT, max_reply_bytes=MAX_REPLY_BYTES,
            ) or json.dumps({"text": ""}).encode()
        except Exception as error:  # noqa: BLE001 - ai_ders.docparse.main() also treats any failure as empty text
            print(f"dphost: {type(error).__name__}: {error}", file=sys.stderr)
            reply = json.dumps({"text": ""}).encode()
    sys.stdout.buffer.write(reply)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
