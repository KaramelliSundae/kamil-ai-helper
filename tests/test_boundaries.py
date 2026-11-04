"""Structural promises about untrusted content, checked against the source so a later change cannot
quietly break them. Nothing that reads mail, announcements or chat text may reach the network."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parent.parent / "ai_ders"
NETWORK = re.compile(r"^\s*(?:import|from)\s+(?:httpx|requests|urllib\.request|http\.client|aiohttp|ftplib|smtplib)\b", re.M)

# Modules that handle untrusted text. None of them may open a network connection of their own.
CONTENT_MODULES = ["text", "mailparse", "rules", "tools", "agent", "watcher", "store", "models"]


@pytest.mark.parametrize("module", CONTENT_MODULES)
def test_content_handling_code_cannot_fetch_anything(module):
    assert not NETWORK.search((SOURCE / f"{module}.py").read_text()), f"{module}.py imports a network client"


def test_the_only_socket_the_parser_module_opens_is_the_local_sandbox():
    source = (SOURCE / "mailparse.py").read_text()
    assert re.findall(r"socket\.socket\(([^)]*)\)", source) == ["socket.AF_UNIX, socket.SOCK_STREAM"]


def test_no_tool_can_reach_the_web_or_a_shell():
    source = (SOURCE / "tools.py").read_text()
    assert not re.search(r"\b(?:subprocess|os\.system|os\.popen|eval|exec)\b", source)
