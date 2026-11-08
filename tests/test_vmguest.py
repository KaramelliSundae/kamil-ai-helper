"""The wire protocol every Firecracker-sandboxed guest (ai_ders.fcguest for mail, ai_ders.dpguest for
documents) speaks over its one vsock connection, tested over a plain socketpair: the framing logic
doesn't care that the real thing is AF_VSOCK, and this runs without Firecracker, KVM, or root, none of
which CI has. load_modules(), drop_capabilities(), install_seccomp() and power_off() need a real guest
kernel and aren't covered here; deploy/linux/firecracker/build-image.sh and a manual boot are what
exercise those.

This file exists because the real bugs here (a too-small guest RAM budget corrupting the initramfs
unpack, a missing recvfrom/sendto in the syscall allowlist, shutdown(SHUT_WR) tearing down
Firecracker's whole vsock relay instead of half-closing it) were all found by booting a real microVM,
not by reasoning about the protocol - this suite is what should have caught the last one."""

from __future__ import annotations

import socket
import struct
import threading

import pytest

import hashlib

from ai_ders.vmguest import INPUT_DAMAGED, TransferDamaged, _recv_exact, read_item, send_reply


def framed(raw: bytes) -> bytes:
    return struct.pack(">Q", len(raw)) + raw + hashlib.sha256(raw).digest()


@pytest.fixture
def pipe():
    a, b = socket.socketpair()
    yield a, b
    a.close()
    b.close()


def test_recv_exact_waits_for_short_reads(pipe):
    guest, other = pipe
    other.sendall(b"ab")
    other.sendall(b"cde")
    assert _recv_exact(guest, 5) == b"abcde"


def test_recv_exact_raises_on_early_close(pipe):
    guest, other = pipe
    other.sendall(b"ab")
    other.close()
    with pytest.raises(ConnectionError):
        _recv_exact(guest, 5)


def test_read_item_is_length_prefixed_not_eof_terminated(pipe):
    guest, other = pipe
    raw = b"Subject: hi\r\n\r\nbody"
    other.sendall(framed(raw))
    # No shutdown/close from `other`: read_item must not be waiting for EOF.
    assert read_item(guest, max_input_bytes=1000) == raw


def test_read_item_refuses_bytes_that_were_damaged_on_the_way(pipe):
    guest, other = pipe
    damaged = bytearray(framed(b"Subject: hi\r\n\r\nbody"))
    damaged[12] ^= 0x01
    other.sendall(bytes(damaged))
    with pytest.raises(TransferDamaged):
        read_item(guest, max_input_bytes=1000)
    assert INPUT_DAMAGED == {"error": "TransferDamaged"}  # what vmhost.DAMAGED_INPUT_REPLY must match


def test_read_item_over_budget_is_none_not_the_bytes(pipe):
    # A real over-budget send is many MB, well past a socketpair's kernel buffer, so sending and
    # draining it in the same thread without a real reader running concurrently would deadlock.
    # A small budget keeps this test fast and single-threaded instead.
    guest, other = pipe
    oversized = 17

    def send_it():
        other.sendall(framed(b"x" * oversized))

    thread = threading.Thread(target=send_it)
    thread.start()
    assert read_item(guest, max_input_bytes=16) is None
    thread.join(5)
    other.sendall(framed(b"next"))  # the digest was drained too, so the stream is still in step
    assert read_item(guest, max_input_bytes=16) == b"next"


def test_send_reply_is_length_prefixed_and_waits_for_the_ack(pipe):
    guest, other = pipe

    def act_like_the_host():
        (size,) = struct.unpack(">Q", _recv_exact(other, 8))
        body = _recv_exact(other, size)
        assert _recv_exact(other, 32) == hashlib.sha256(body).digest()
        other.sendall(b"\x01")
        return body

    result = {}
    thread = threading.Thread(target=lambda: result.__setitem__("body", act_like_the_host()))
    thread.start()
    send_reply(guest, {"subject": "hi"})
    thread.join(5)
    assert result["body"] == b'{"subject": "hi"}'
