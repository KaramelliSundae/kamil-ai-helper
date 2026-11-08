"""Shared guest-side machinery for every Firecracker-sandboxed content reader (ai_ders/fcguest.py for
mail, ai_ders/dpguest.py for documents). Runs as PID 1 inside a disposable microVM with no disk and no
network device: the kernel and this project's own code are the only things in it (see
deploy/linux/firecracker/build-image.sh), and the VM is thrown away after one item. See
ai_ders/vmhost.py for the host side that boots it.

Order matters here. Setup (loading the vsock modules, opening the one port, accepting the host's one
connection) needs capabilities and syscalls that the content itself must never be able to reach. So
setup runs first, then `run()` drops every capability but the one the final reboot needs and installs
a syscall allowlist, and only *then* does a single byte of the content get read. From that point on
this process can read and write the one already-open socket and exit; nothing else, so even a bug in
an image decoder or a document parser that gets code running has nothing to call. The guest kernel is
still a boundary of its own (Firecracker's VM isolation, not this process), but a smaller syscall
surface is also fewer ways to make that kernel misbehave, the same reasoning AWS gives for running
Firecracker with seccomp rather than relying on the VM boundary alone.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import resource
import signal
import socket
import struct
from collections.abc import Callable

VSOCK_PORT = 52000

# Each payload, both ways, is followed by its SHA-256. Firecracker 1.13's vsock relay was seen to repeat a
# 32 KiB block at a 256 KiB boundary of a large guest-to-host reply when the host read slower than the guest
# wrote (1 run in 8 for a 390 KB reply); the length still matched, so only a checksum notices. A damaged
# transfer is no one's fault, and the host boots a fresh VM for it (vmhost.TransferError).
DIGEST_BYTES = 32
# What the guest answers when the content arrived damaged: the host retries instead of storing it.
INPUT_DAMAGED = {"error": "TransferDamaged"}
# hashlib may load OpenSSL lazily on first use; doing it here, at import, keeps that before the syscall filter.
hashlib.sha256(b"").digest()

# Decompressed by deploy/linux/firecracker/build-image.sh from the host's own /lib/modules, in the
# dependency order `modinfo` gives (virtio_mmio and vsock have none; the two transport modules need
# vsock, and virtio_transport also needs transport_common). The same four modules for every guest:
# vsock is how all of them talk to the host, regardless of what they parse.
MODULE_DIR = "/lib/modules.fc"
MODULES = ("virtio_mmio.ko", "vsock.ko", "vmw_vsock_virtio_transport_common.ko", "vmw_vsock_virtio_transport.ko")

MAX_OPEN_FILES = 64

# Started as the exact list ai-ders-mailparse@.service's and ai-ders-docparse@.service's
# SystemCallFilter both use (identical in both, strace-derived there), plus "reboot" for this guest's
# own clean shutdown. Narrowed from that starting point, verified against all four real content
# scenarios (plain mail, image attachment, PDF, DOCX) after each removal:
#   - "execve": that unit's own comment calls it "a few harmless calls Python makes on other paths" -
#     true there, since systemd hands it an already-connected fd; irrelevant here regardless, since
#     this guest's filesystem has nothing executable to exec but the interpreter already running.
#   - "socket", "getsockopt", "getsockname", "getpeername": needed on the host side because systemd
#     wraps an inherited fd 0 as sys.stdin and Python's generic stdin machinery probes it with
#     socket() to decide how to wrap it. This guest instead builds its own AF_VSOCK socket object
#     directly, before the filter goes on, and never touches the socket API again after that -
#     read_item()/send_reply() only ever call recv()/sendall() on the object it already has.
# openat() and friends for module loading still happen *inside* this filter (parse() does its heavy
# imports - imap_tools, Pillow, pypdf - lazily on first use), so there's no shortcut to a smaller list
# there without re-running the same strace work the host unit's own list was built from.
SYSCALL_ALLOWLIST = (
    "access", "arch_prctl", "brk", "close", "exit", "exit_group", "fcntl", "futex",
    "getrandom", "gettid", "ioctl",
    "fstat", "fstatfs", "newfstatat", "statx", "stat", "lstat", "getdents64", "lseek", "openat",
    "pread64", "read", "readv", "readlink", "readlinkat", "write", "writev",
    "mmap", "mprotect", "mremap", "munmap", "madvise", "prlimit64", "rseq",
    "rt_sigaction", "rt_sigprocmask", "rt_sigreturn", "sigaltstack", "set_robust_list", "set_tid_address",
    "epoll_create1", "epoll_ctl", "epoll_wait", "epoll_pwait", "poll", "ppoll",
    "clock_gettime", "clock_nanosleep", "nanosleep",
    "sched_getaffinity", "sched_yield", "getpid", "getppid", "getuid", "geteuid", "getgid", "getegid",
    "getcwd", "uname", "sysinfo", "faccessat", "faccessat2", "dup", "dup3", "shutdown",
    "recvfrom", "sendto",
    # Not in either systemd unit's list: this guest's own clean-shutdown trick (boot_args has reboot=k).
    "reboot",
)

# x86_64 syscall numbers with no glibc wrapper, for raw use via syscall(2).
_SYS_FINIT_MODULE = 313

_libc = ctypes.CDLL(None, use_errno=True)


def _check(ok: bool, what: str) -> None:
    if not ok:
        raise OSError(ctypes.get_errno(), what)


def load_modules() -> None:
    for name in MODULES:
        fd = os.open(f"{MODULE_DIR}/{name}", os.O_RDONLY)
        try:
            rc = _libc.syscall(_SYS_FINIT_MODULE, fd, b"", 0)
            _check(rc == 0, f"finit_module({name})")
        finally:
            os.close(fd)


class _CapHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class _CapData(ctypes.Structure):
    _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]


_SYS_CAPSET = 126
_LINUX_CAPABILITY_VERSION_3 = 0x20080522


class _ArgCmp(ctypes.Structure):
    """libseccomp's struct scmp_arg_cmp, for seccomp_rule_add_array (the non-variadic twin of
    seccomp_rule_add, which ctypes can't call directly since it's a C varargs function)."""

    _fields_ = [
        ("arg", ctypes.c_uint),
        ("op", ctypes.c_int),
        ("datum_a", ctypes.c_uint64),
        ("datum_b", ctypes.c_uint64),
    ]


def drop_capabilities(keep: int) -> None:
    """Drops every capability but `keep` (must be < 32: true of CAP_SYS_BOOT, the only one anything
    here keeps). Must run before accept() is done with CAP_SYS_MODULE.

    Two calls, not one: PR_CAPBSET_DROP only lowers the *bounding set*, a ceiling on what this process
    could ever gain back (by exec'ing something with file capabilities, say) - it does nothing to the
    capabilities a process already started with as root actually holds right now. That's what
    capset() is for, and skipping it would leave this process able to do anything root can until the
    seccomp filter goes on right after this, which is correct but makes that filter the *only* thing
    standing between "root" and the mail or document it's about to read, instead of one of two."""
    PR_CAPBSET_DROP = 24
    for cap in range(41):
        if cap != keep:
            _libc.prctl(PR_CAPBSET_DROP, cap, 0, 0, 0)

    header = _CapHeader(version=_LINUX_CAPABILITY_VERSION_3, pid=0)
    bit = 1 << keep
    data = (_CapData * 2)(_CapData(bit, bit, 0), _CapData(0, 0, 0))
    rc = _libc.syscall(_SYS_CAPSET, ctypes.byref(header), ctypes.byref(data[0]))
    _check(rc == 0, "capset")


def install_seccomp(names: tuple[str, ...]) -> None:
    """SCMP_ACT_KILL_PROCESS for anything not in `names`, or for the one thing carved out of `names`
    even though its syscall names are in it: mmap/mprotect asking for memory that's writable *and*
    executable at once (the same thing MemoryDenyWriteExecute=yes gets every other sandboxed unit in
    this project). A legitimate Python process never needs that, and it's one of the more direct
    routes from "got code running via a parser bug" to "that code can write and then jump to its own
    machine code".

    This can't be a straightforward "add one more rule that returns EACCES for the bad case": tested
    on this libseccomp version, an unconditional ALLOW rule for the same syscall always won over a
    conditional one regardless of which was added first. What does work is never adding mmap/mprotect
    an unconditional rule at all, and instead allowing exactly the safe cases by their own conditions,
    so the dangerous one is the only thing left to fall through to the kill-by-default above."""
    SCMP_ACT_ALLOW = 0x7FFF0000
    SCMP_ACT_KILL_PROCESS = 0x80000000
    SCMP_CMP_MASKED_EQ = 7
    PROT_WRITE = 0x2
    PROT_EXEC = 0x4
    WX_GUARDED_SYSCALLS = {"mmap", "mprotect"}

    lib = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_rule_add.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_rule_add_array.restype = ctypes.c_int
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
    lib.seccomp_load.restype = ctypes.c_int
    lib.seccomp_load.argtypes = [ctypes.c_void_p]

    ctx = lib.seccomp_init(SCMP_ACT_KILL_PROCESS)
    _check(bool(ctx), "seccomp_init")

    def allow_unless_arg2_has(syscall_name: str, bit: int) -> None:
        nr = lib.seccomp_syscall_resolve_name(syscall_name.encode())
        cmp_ = _ArgCmp(arg=2, op=SCMP_CMP_MASKED_EQ, datum_a=bit, datum_b=0)
        rc = lib.seccomp_rule_add_array(ctx, SCMP_ACT_ALLOW, nr, 1, ctypes.byref(cmp_))
        _check(rc == 0, f"seccomp_rule_add_array({syscall_name}, allow unless bit {bit:#x} set)")

    # mmap(..., prot, ...): safe whenever PROT_WRITE is absent, or whenever PROT_EXEC is absent - that
    # covers every combination except both together, which is exactly what's meant to fall through.
    allow_unless_arg2_has("mmap", PROT_WRITE)
    allow_unless_arg2_has("mmap", PROT_EXEC)
    # mprotect(..., ..., prot): a plain `MemoryDenyWriteExecute=yes`-style policy refuses PROT_EXEC
    # outright here, since mprotect only ever changes an *existing* mapping's protection - anything
    # meant to be executable should have been mapped that way from the start, via mmap.
    allow_unless_arg2_has("mprotect", PROT_EXEC)

    for name in names:
        if name in WX_GUARDED_SYSCALLS:
            continue
        nr = lib.seccomp_syscall_resolve_name(name.encode())
        if nr == -1:
            raise OSError(f"unknown syscall for this arch: {name}")
        rc = lib.seccomp_rule_add(ctx, SCMP_ACT_ALLOW, nr, 0)
        _check(rc == 0, f"seccomp_rule_add({name})")
    _check(lib.seccomp_load(ctx) == 0, "seccomp_load")


def apply_limits(memory_bytes: int, wall_seconds: int) -> None:
    resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    resource.setrlimit(resource.RLIMIT_CPU, (wall_seconds, wall_seconds))
    resource.setrlimit(resource.RLIMIT_NOFILE, (MAX_OPEN_FILES, MAX_OPEN_FILES))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # RLIMIT_CPU covers a parser spinning on the CPU: at the hard limit the kernel sends SIGKILL, which
    # even PID 1 can't ignore. Time spent blocked doesn't count against it, so wall-clock time needs an
    # alarm too - but the kernel silently drops a default-action signal aimed at PID 1 (tested: an
    # unhandled alarm does nothing here), so the alarm needs a handler that ends the VM itself.
    signal.signal(signal.SIGALRM, lambda *_: power_off())
    signal.alarm(wall_seconds)


def _recv_exact(connection: socket.socket, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = connection.recv(min(remaining, 1 << 16))
        if not chunk:
            raise ConnectionError("connection closed early")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class TransferDamaged(Exception):
    """The bytes that arrived are not the bytes the host sent (their SHA-256 differs)."""


def read_item(connection: socket.socket, max_input_bytes: int) -> bytes | None:
    """Length-prefixed, not EOF-terminated: shutdown(SHUT_WR) on a Firecracker vsock-proxied
    connection was observed to tear down the whole channel rather than half-close it, so neither side
    here ever relies on seeing EOF. Returns None, distinct from an empty item, when the host says it's
    over budget. Raises TransferDamaged when the item doesn't match the SHA-256 that follows it."""
    (size,) = struct.unpack(">Q", _recv_exact(connection, 8))
    if size > max_input_bytes:
        _recv_exact(connection, size + DIGEST_BYTES)  # drain so the host's send doesn't block on a full buffer
        return None
    raw = _recv_exact(connection, size)
    if hashlib.sha256(raw).digest() != _recv_exact(connection, DIGEST_BYTES):
        raise TransferDamaged
    return raw


def send_reply(connection: socket.socket, reply: dict) -> None:
    payload = json.dumps(reply, ensure_ascii=False).encode()
    connection.sendall(struct.pack(">Q", len(payload)) + payload + hashlib.sha256(payload).digest())
    # Firecracker relays vsock bytes to the host's Unix socket asynchronously; without waiting here,
    # the triple fault from power_off() can win the race and the VM vanishes before the reply crosses
    # over. The host side sends this one byte back only once it has read the whole reply.
    connection.recv(1)


def power_off() -> None:
    LINUX_REBOOT_CMD_RESTART = 0x01234567  # boot_args carries reboot=k: this triple-faults, which
    _libc.reboot(LINUX_REBOOT_CMD_RESTART)  # Firecracker reads as the guest shutting itself down.


def _wire_console() -> None:
    """PID 1's inherited fds aren't guaranteed to be the console, so without this a crash here is
    invisible instead of showing up in Firecracker's own log."""
    console = os.open("/dev/console", os.O_RDWR)
    os.dup2(console, 1)
    os.dup2(console, 2)
    if console > 2:
        os.close(console)


def run(build_reply: Callable[[bytes], dict], max_input_bytes: int, memory_bytes: int, wall_seconds: int) -> None:
    """The whole guest lifecycle. `build_reply(raw)` is the one content-specific part: it gets the raw
    bytes and returns the JSON-ready reply dict (mirroring what that content type's own sandboxed
    `main()` already produced before this existed)."""
    _wire_console()
    load_modules()

    listener = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    listener.bind((socket.VMADDR_CID_ANY, VSOCK_PORT))
    listener.listen(1)
    connection, _ = listener.accept()
    listener.close()

    # Everything above needed CAP_SYS_MODULE and ordinary socket syscalls. Nothing below does.
    drop_capabilities(keep=22)  # CAP_SYS_BOOT, for the reboot() at the end
    apply_limits(memory_bytes, wall_seconds)
    install_seccomp(SYSCALL_ALLOWLIST)

    try:
        raw = read_item(connection, max_input_bytes)
        reply = {"error": "too large"} if raw is None else build_reply(raw)
    except TransferDamaged:
        reply = INPUT_DAMAGED
    except Exception as error:  # noqa: BLE001 - report, never raise into a traceback
        reply = {"error": type(error).__name__}
    try:
        send_reply(connection, reply)
    except OSError:
        pass  # the host side reports this as "no reply"; the item is skipped, not lost
    power_off()
