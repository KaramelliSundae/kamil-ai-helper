"""ai_ders.vmhost (shared by ai_ders.fchost and ai_ders.dphost) talks to two things over Unix sockets:
Firecracker's HTTP API, and its vsock relay (docs/vsock.md's "CONNECT <port>\\n" / "OK <port>\\n"
handshake). Both are faked here with plain threads, so these tests exercise the actual wire logic
(the HTTP/1.1 framing in _Api, the length-prefixed vsock protocol in _vsock_exchange) without needing
Firecracker, KVM, or root.

Nothing here boots a real microVM: run_vm()'s own subprocess handling and the real Firecracker API
aren't covered, only the protocol code that was the actual source of bugs during development (a
too-small Content-Length read, and the shutdown(SHUT_WR)-breaks-the-relay issue _vsock_exchange's
length-prefixed protocol exists to avoid)."""

from __future__ import annotations

import os
import socket
import struct
import threading

import pytest

from ai_ders import vmhost
import hashlib

from ai_ders.vmhost import BootError, GuestError, TransferError, _Api, _handshake, _vsock_exchange


def digest(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


@pytest.fixture
def sock_path(tmp_path):
    # AF_UNIX paths are limited to about 100 bytes; tmp_path can exceed that on macOS.
    path = f"/tmp/ai-ders-fc-test-{os.getpid()}-{threading.get_ident()}.sock"
    yield path
    if os.path.exists(path):
        os.unlink(path)


def fake_server(path: str, handle):
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(1)

    def run():
        connection, _ = server.accept()
        with connection:
            handle(connection)
        server.close()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def test_api_put_reads_the_body_by_content_length(sock_path):
    def handle(connection):
        request = connection.recv(65536)
        assert request.startswith(b"PUT /boot-source HTTP/1.1\r\n")
        assert b'{"kernel_image_path": "x"}' in request
        connection.sendall(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")

    thread = fake_server(sock_path, handle)
    api = _Api(sock_path, timeout=5)
    api.put("/boot-source", {"kernel_image_path": "x"})
    api.close()
    thread.join(5)


def test_api_put_raises_on_a_non_2xx_status(sock_path):
    def handle(connection):
        connection.recv(65536)
        connection.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\n\r\n{}")

    thread = fake_server(sock_path, handle)
    api = _Api(sock_path, timeout=5)
    with pytest.raises(BootError):
        api.put("/machine-config", {})
    api.close()
    thread.join(5)


def test_handshake_follows_the_vsock_connect_protocol(sock_path):
    def handle(connection):
        request = connection.recv(256)
        assert request == b"CONNECT 52000\n"
        connection.sendall(b"OK 1073741824\n")

    thread = fake_server(sock_path, handle)
    connection = _handshake(sock_path)
    connection.close()
    thread.join(5)


def test_handshake_raises_when_firecracker_refuses_the_port(sock_path):
    def handle(connection):
        connection.recv(256)
        connection.close()  # Firecracker does this when nothing in the guest is listening yet

    thread = fake_server(sock_path, handle)
    with pytest.raises(ConnectionError):
        _handshake(sock_path)
    thread.join(5)


def test_vsock_exchange_is_length_prefixed_both_ways(sock_path):
    def handle(connection):
        request = connection.recv(256)
        assert request == b"CONNECT 52000\n"
        connection.sendall(b"OK 1073741824\n")
        (size,) = struct.unpack(">Q", connection.recv(8))
        mail = connection.recv(size)
        assert mail == b"raw mail bytes"
        assert connection.recv(32) == digest(mail)
        reply = b'{"subject": "hi"}'
        connection.sendall(struct.pack(">Q", len(reply)) + reply + digest(reply))
        ack = connection.recv(1)
        assert ack == b"\x01"

    thread = fake_server(sock_path, handle)
    reply = _vsock_exchange(sock_path, b"raw mail bytes", max_reply_bytes=1000, reply_timeout=5)
    thread.join(5)
    assert reply == b'{"subject": "hi"}'


def test_vsock_exchange_retries_the_handshake_until_the_guest_is_listening(sock_path):
    attempts = []

    def handle(connection):
        attempts.append(1)
        if len(attempts) < 2:
            connection.recv(256)
            connection.close()  # as if the guest hasn't called listen() yet
            return
        connection.recv(256)
        connection.sendall(b"OK 1\n")
        (size,) = struct.unpack(">Q", connection.recv(8))
        connection.recv(size + 32)
        connection.sendall(struct.pack(">Q", 2) + b"{}" + digest(b"{}"))
        connection.recv(1)

    # One listening socket, two sequential accept()s: simpler than juggling bind/rebind across a
    # refused connection, and matches what a real retried connect() to the same path would see.
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    server.listen(2)

    def serve():
        for _ in range(2):
            conn, _ = server.accept()
            with conn:
                handle(conn)
        server.close()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    reply = _vsock_exchange(sock_path, b"x", max_reply_bytes=1000, reply_timeout=5)
    thread.join(5)
    assert reply == b"{}"
    assert len(attempts) == 2


def test_a_guest_that_dies_after_taking_the_content_is_a_guest_error(sock_path):
    # The handshake worked, so the VM was up and had the mail: dying now is the mail's doing, and must
    # not look like a boot failure, which would get it retried in a fresh VM.
    def handle(connection):
        connection.recv(256)
        connection.sendall(b"OK 1\n")
        connection.recv(8)
        connection.close()

    thread = fake_server(sock_path, handle)
    with pytest.raises(GuestError):
        _vsock_exchange(sock_path, b"raw", max_reply_bytes=1000, reply_timeout=5)
    thread.join(5)


@pytest.mark.parametrize(
    "answer",
    [
        # The reply as sent, then damaged in the relay: a 32 KiB block repeated, as was seen on the server.
        lambda reply: struct.pack(">Q", len(reply)) + reply[:4] + reply[:4] + reply[8:] + digest(reply),
        # The guest says what it got was not what was sent.
        lambda reply: struct.pack(">Q", 28) + b'{"error": "TransferDamaged"}' + digest(b'{"error": "TransferDamaged"}'),
    ],
)
def test_a_damaged_transfer_is_a_transfer_error_not_a_guest_error(sock_path, answer):
    def handle(connection):
        connection.recv(256)
        connection.sendall(b"OK 1\n")
        (size,) = struct.unpack(">Q", connection.recv(8))
        connection.recv(size + 32)
        connection.sendall(answer(b'{"subject": "hi"}'))
        connection.recv(1)

    thread = fake_server(sock_path, handle)
    with pytest.raises(TransferError):
        _vsock_exchange(sock_path, b"raw", max_reply_bytes=1000, reply_timeout=5)
    thread.join(5)


def test_run_vm_retries_a_damaged_transfer(monkeypatch):
    calls = []

    def damaged_once(*args):
        calls.append(1)
        if len(calls) == 1:
            raise TransferError("damaged")
        return b"{}"

    monkeypatch.setattr(vmhost, "_run_once", damaged_once)
    monkeypatch.setattr(vmhost.time, "sleep", lambda _: None)
    assert vmhost.run_vm(b"x", kernel_dir="", rdinit="", mem_size_mib=1, reply_timeout=1, max_reply_bytes=1) == b"{}"
    assert len(calls) == 2


def test_run_vm_retries_a_vm_that_never_booted(monkeypatch):
    calls = []

    def flaky(*args):
        calls.append(1)
        if len(calls) < vmhost.BOOT_ATTEMPTS:
            raise BootError("did not come up")
        return b"{}"

    monkeypatch.setattr(vmhost, "_run_once", flaky)
    monkeypatch.setattr(vmhost.time, "sleep", lambda _: None)
    assert vmhost.run_vm(b"x", kernel_dir="", rdinit="", mem_size_mib=1, reply_timeout=1, max_reply_bytes=1) == b"{}"
    assert len(calls) == vmhost.BOOT_ATTEMPTS


def test_run_vm_gives_up_after_the_last_boot_attempt(monkeypatch):
    def never(*args):
        raise BootError("did not come up")

    monkeypatch.setattr(vmhost, "_run_once", never)
    monkeypatch.setattr(vmhost.time, "sleep", lambda _: None)
    with pytest.raises(BootError):
        vmhost.run_vm(b"x", kernel_dir="", rdinit="", mem_size_mib=1, reply_timeout=1, max_reply_bytes=1)


def test_run_vm_never_retries_a_guest_error(monkeypatch):
    calls = []

    def poison(*args):
        calls.append(1)
        raise GuestError("the parser crashed")

    monkeypatch.setattr(vmhost, "_run_once", poison)
    with pytest.raises(GuestError):
        vmhost.run_vm(b"x", kernel_dir="", rdinit="", mem_size_mib=1, reply_timeout=1, max_reply_bytes=1)
    assert len(calls) == 1
