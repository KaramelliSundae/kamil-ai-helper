"""Shared host-side machinery for every Firecracker-sandboxed content reader (ai_ders/fchost.py for
mail, ai_ders/dphost.py for documents). Each one is started once per connection by systemd socket
activation, exactly like the unsandboxed-VM parser it replaces: raw content bytes in on stdin, JSON
out on stdout, then it exits. `ai_ders.mailparse.SandboxedParser` and
`ai_ders.docparse.SandboxedDocumentReader` already speak this contract, so pointing their socket
setting at one of these units instead of the systemd-sandbox one is the only change needed on the
watcher side.

Unlike the thing it replaces, this process never looks at the content's bytes itself. It boots a
disposable microVM with no disk and no network device (deploy/linux/firecracker/build-image.sh builds
the kernel and initramfs), hands the raw bytes to ai_ders.vmguest.run() inside it over one vsock
connection, and relays back whatever JSON that process returns. The VM is the boundary here, not this
launcher, so this file stays thin: talk to the Firecracker API, proxy one vsock stream, tear down.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import uuid

from .vmguest import VSOCK_PORT

VCPU_COUNT = 1
BOOT_ARGS = "console=ttyS0 reboot=k panic=1 pci=off"
API_TIMEOUT = 5.0  # waiting for the API socket to appear, and for each Firecracker API call
HANDSHAKE_TIMEOUT = 10.0  # waiting for the guest to boot, load vsock's modules and start listening
BOOT_ATTEMPTS = 3
FIRECRACKER_BIN = os.environ.get("FIRECRACKER_BIN", "/usr/bin/firecracker")


class BootError(Exception):
    """The VM never came up or never finished the vsock handshake: nothing had seen the content yet,
    so it isn't the content's fault, and run_vm() boots a fresh VM and tries again."""


class GuestError(Exception):
    """The guest was up and took the content, then died or broke the protocol before replying - what
    a crash inside the parser looks like from out here. The content's fault, so never retried: a mail
    that kills its VM would only kill the next one too."""


class _Api:
    """A tiny HTTP/1.1 client over the Firecracker API's Unix socket. Firecracker's embedded server
    always sends Content-Length (never chunked), which is all this needs to handle."""

    def __init__(self, path: str, timeout: float):
        self._connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._connection.settimeout(timeout)
        self._connection.connect(path)
        self._buffer = b""

    def put(self, path: str, body: dict) -> None:
        payload = json.dumps(body).encode()
        request = (
            f"PUT {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(payload)}\r\nConnection: keep-alive\r\n\r\n"
        ).encode() + payload
        self._connection.sendall(request)
        status, _ = self._read_response()
        if not 200 <= status < 300:
            raise BootError(f"firecracker API {path} -> {status}")

    def _read_response(self) -> tuple[int, bytes]:
        while b"\r\n\r\n" not in self._buffer:
            chunk = self._connection.recv(4096)
            if not chunk:
                raise BootError("firecracker API connection closed")
            self._buffer += chunk
        head, _, self._buffer = self._buffer.partition(b"\r\n\r\n")
        status = int(head.split(b"\r\n", 1)[0].split(b" ")[1])
        length = 0
        for line in head.split(b"\r\n")[1:]:
            name, _, value = line.partition(b":")
            if name.strip().lower() == b"content-length":
                length = int(value)
        while len(self._buffer) < length:
            chunk = self._connection.recv(4096)
            if not chunk:
                break
            self._buffer += chunk
        body, self._buffer = self._buffer[:length], self._buffer[length:]
        return status, body

    def close(self) -> None:
        self._connection.close()


def _wait_for(path: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if os.path.exists(path):
            return
        time.sleep(0.01)
    raise BootError(f"{path} never appeared")


def _recv_exact(connection: socket.socket, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = connection.recv(min(remaining, 1 << 16))
        if not chunk:
            raise GuestError("connection closed early")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _handshake(uds_path: str) -> socket.socket:
    """One attempt: connect to Firecracker's vsock proxy socket and send "CONNECT <port>\\n". Firecracker
    terminates the connection immediately if nothing in the guest is listening on that port yet (see
    docs/vsock.md), which during the first moment after InstanceStart just means the guest hasn't
    finished loading its vsock modules yet, not a real failure, so the caller retries this."""
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(1.0)
    connection.connect(uds_path)
    connection.sendall(f"CONNECT {VSOCK_PORT}\n".encode())
    ack = b""
    while not ack.endswith(b"\n"):
        chunk = connection.recv(256)
        if not chunk:
            connection.close()
            raise ConnectionError("closed before the guest answered")
        ack += chunk
    if not ack.startswith(b"OK "):
        connection.close()
        raise ConnectionError(f"handshake refused: {ack!r}")
    return connection


def _vsock_exchange(uds_path: str, raw: bytes, max_reply_bytes: int, reply_timeout: float) -> bytes:
    """Firecracker creates `uds_path` only once the VM has actually started, and the guest side of the
    handshake only succeeds once ai_ders.vmguest has loaded the vsock modules and called listen(), both
    a little after the /actions API call returns. So this retries the whole handshake, not just the
    wait for the socket file, until HANDSHAKE_TIMEOUT runs out.

    Both directions are length-prefixed (an 8-byte big-endian size, then that many bytes), not
    EOF-terminated: shutdown(SHUT_WR) on this connection was observed to tear down Firecracker's whole
    vsock relay rather than half-close it. The trailing single byte tells the guest its reply has
    actually crossed over before it triggers the VM's own clean shutdown."""
    deadline = time.monotonic() + HANDSHAKE_TIMEOUT
    connection = None
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            connection = _handshake(uds_path)
            break
        except (OSError, ConnectionError) as error:
            last_error = error
            time.sleep(0.02)
    if connection is None:
        raise BootError(f"vsock handshake never succeeded: {last_error}")
    # From here on the guest has the content, so any failure is a GuestError, never a BootError.
    try:
        connection.settimeout(reply_timeout)
        connection.sendall(struct.pack(">Q", len(raw)) + raw)
        (size,) = struct.unpack(">Q", _recv_exact(connection, 8))
        if size > max_reply_bytes:
            raise GuestError(f"guest's reply is too large: {size} bytes")
        reply = _recv_exact(connection, size)
        connection.sendall(b"\x01")  # ai_ders.vmguest waits for this before its own clean shutdown
        return reply
    except OSError as error:
        raise GuestError(f"vsock exchange broke: {error}") from error
    finally:
        connection.close()


def _run_once(raw: bytes, kernel_dir: str, rdinit: str, mem_size_mib: int, reply_timeout: float, max_reply_bytes: int) -> bytes:
    # dir= given explicitly: without it, tempfile probes each candidate directory by writing a small
    # file, which LimitFSIZE=0 in the unit refuses, so it would find "no usable temporary directory".
    # Only sockets go in here, and the file-size limit doesn't apply to those.
    try:
        run_dir = tempfile.mkdtemp(prefix="fc-", dir="/tmp")
    except OSError as error:
        raise BootError(f"no scratch directory: {error}") from error
    api_sock = f"{run_dir}/api.sock"
    vsock_uds = f"{run_dir}/v.sock"
    process = None
    try:
        try:
            process = subprocess.Popen(
                [FIRECRACKER_BIN, "--api-sock", api_sock, "--id", uuid.uuid4().hex],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            _wait_for(api_sock, API_TIMEOUT)
            # The socket file appears at bind(), a moment before Firecracker calls listen(); a connect in
            # that gap is refused. Like every other failure before the handshake, that's a BootError.
            api = _Api(api_sock, API_TIMEOUT)
            try:
                api.put("/boot-source", {
                    "kernel_image_path": f"{kernel_dir}/vmlinux",
                    "initrd_path": f"{kernel_dir}/initramfs.cpio.gz",
                    "boot_args": f"{BOOT_ARGS} rdinit={rdinit}",
                })
                api.put("/machine-config", {"vcpu_count": VCPU_COUNT, "mem_size_mib": mem_size_mib})
                api.put("/vsock", {"guest_cid": 3, "uds_path": vsock_uds})
                api.put("/actions", {"action_type": "InstanceStart"})
            finally:
                api.close()
        except OSError as error:
            raise BootError(f"firecracker did not start: {error}") from error
        return _vsock_exchange(vsock_uds, raw, max_reply_bytes, reply_timeout)
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2.0)
        shutil.rmtree(run_dir, ignore_errors=True)


def run_vm(
    raw: bytes, *, kernel_dir: str, rdinit: str, mem_size_mib: int, reply_timeout: float, max_reply_bytes: int
) -> bytes:
    """Boots one fresh microVM, hands it `raw` over vsock, and returns its JSON reply bytes. Raises
    BootError if no VM came up after BOOT_ATTEMPTS tries, GuestError if one did and then failed on
    the content (never retried). `kernel_dir` holds vmlinux and initramfs.cpio.gz, built by
    deploy/linux/firecracker/build-image.sh: one shared image for every content type (it's the same
    venv either way), with a separate tiny /init-* entrypoint per type baked in at build time, picked
    with `rdinit` here (e.g. "/init-mail", "/init-doc") so each VM only ever runs the one parser it
    booted for. Retrying the boot matters because a mail whose VM never started gets stored as
    unreadable: a busy moment on the machine shouldn't cost a mail its content."""
    for attempt in range(1, BOOT_ATTEMPTS + 1):
        try:
            return _run_once(raw, kernel_dir, rdinit, mem_size_mib, reply_timeout, max_reply_bytes)
        except BootError:
            if attempt == BOOT_ATTEMPTS:
                raise
            time.sleep(0.5 * attempt)
    raise AssertionError("unreachable")
