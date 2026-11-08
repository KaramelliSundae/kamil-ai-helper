"""Guest-side entrypoint for the Firecracker mail sandbox, run as /init-mail inside the microVM
ai_ders/fchost.py boots. The actual machinery (module loading, capability drop, seccomp, the
length-prefixed vsock protocol) is shared with every other content type in ai_ders/vmguest.py; this
file is just that machinery pointed at ai_ders.mailparse.parse().
"""

from __future__ import annotations

from .mailparse import MAX_INPUT_BYTES, parse
from .vmguest import run

# The same budgets as deploy/linux/ai-ders-mailparse@.service, but enforced differently: memory as
# address space (RLIMIT_AS), not a cgroup, so an over-budget image raises MemoryError in here - which
# mailparse.clean_image() catches and skips - instead of the whole process being killed mid-mail.
MEMORY_BYTES = 384 * 2**20
WALL_SECONDS = 30


def main() -> None:
    run(parse, MAX_INPUT_BYTES, MEMORY_BYTES, WALL_SECONDS)


if __name__ == "__main__":
    main()
