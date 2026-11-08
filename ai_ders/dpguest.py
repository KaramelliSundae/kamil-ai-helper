"""Guest-side entrypoint for the Firecracker document sandbox, run as /init-doc inside the microVM
ai_ders/dphost.py boots. The actual machinery (module loading, capability drop, seccomp, the
length-prefixed vsock protocol) is shared with every other content type in ai_ders/vmguest.py; this
file is just that machinery pointed at ai_ders.docparse.parse().
"""

from __future__ import annotations

from .docparse import MAX_INPUT_BYTES, parse
from .vmguest import run

# The same budgets as deploy/linux/ai-ders-docparse@.service, with memory as address space (RLIMIT_AS)
# rather than a cgroup: an over-budget document raises MemoryError and reads as empty, same outcome.
MEMORY_BYTES = 384 * 2**20
WALL_SECONDS = 30


def build_reply(raw: bytes) -> dict:
    # docparse.parse() returns plain text, not a reply dict, matching ai_ders.docparse.main()'s own
    # {"text": ...} wire shape rather than ai_ders.mailparse.parse()'s (already a dict).
    return {"text": parse(raw)}


def main() -> None:
    run(build_reply, MAX_INPUT_BYTES, MEMORY_BYTES, WALL_SECONDS)


if __name__ == "__main__":
    main()
