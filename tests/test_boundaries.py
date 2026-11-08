"""Structural promises about untrusted content, checked against the source so a later change cannot
quietly break them. Nothing that reads mail, announcements or chat text may reach the network."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parent.parent / "ai_ders"
NETWORK = re.compile(r"^\s*(?:import|from)\s+(?:httpx|requests|urllib\.request|http\.client|aiohttp|ftplib|smtplib)\b", re.M)

# Modules that handle untrusted text. None of them may open a network connection of their own.
CONTENT_MODULES = [
    "text", "mailparse", "docparse", "fcguest", "dpguest", "vmguest",
    "rules", "tools", "agent", "watcher", "store", "models", "reply", "mailthread",
]


@pytest.mark.parametrize("module", CONTENT_MODULES)
def test_content_handling_code_cannot_fetch_anything(module):
    assert not NETWORK.search((SOURCE / f"{module}.py").read_text()), f"{module}.py imports a network client"


def test_the_only_socket_the_parser_module_opens_is_the_local_sandbox():
    source = (SOURCE / "mailparse.py").read_text()
    assert re.findall(r"socket\.socket\(([^)]*)\)", source) == ["socket.AF_UNIX, socket.SOCK_STREAM"]


def test_the_only_socket_the_firecracker_guests_open_is_vsock():
    # Shared by every guest (ai_ders.fcguest, ai_ders.dpguest): the one socket.socket() call lives in
    # ai_ders.vmguest, not in either thin per-content wrapper.
    source = (SOURCE / "vmguest.py").read_text()
    assert re.findall(r"socket\.socket\(([^)]*)\)", source) == ["socket.AF_VSOCK, socket.SOCK_STREAM"]


def test_the_only_sockets_the_firecracker_host_opens_are_local():
    # Shared by every host launcher (ai_ders.fchost, ai_ders.dphost): Firecracker's API socket and its
    # vsock relay proxy, both AF_UNIX, both local to this machine.
    source = (SOURCE / "vmhost.py").read_text()
    assert set(re.findall(r"socket\.socket\(([^)]*)\)", source)) == {"socket.AF_UNIX, socket.SOCK_STREAM"}


def test_no_tool_can_reach_the_web_or_a_shell():
    source = (SOURCE / "tools.py").read_text()
    assert not re.search(r"\b(?:subprocess|os\.system|os\.popen|eval|exec)\b", source)


def test_only_the_sending_sandbox_speaks_smtp():
    """Mail leaves this machine from ai_ders.mailsend alone (the digest borrows its open_smtp)."""
    speaking = {path.stem for path in SOURCE.glob("*.py") if re.search(r"^\s*import smtplib\b", path.read_text(), re.M)}
    assert speaking == {"mailsend"}


def test_the_api_never_holds_the_mail_password():
    assert "mail_password" not in (SOURCE / "api.py").read_text()
    unit = (SOURCE.parent / "deploy" / "linux" / "ai-ders-api.service").read_text()
    assert not re.search(r"^LoadCredential\w*=mail_password", unit, re.M)
    sender = (SOURCE.parent / "deploy" / "linux" / "ai-ders-mailsend@.service").read_text()
    assert re.search(r"^LoadCredentialEncrypted=mail_password", sender, re.M)
    assert re.search(r"^InaccessiblePaths=.*/var/lib/ai-ders\b", sender, re.M)  # the database stays out of reach
