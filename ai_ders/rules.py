"""Mail importance without an LLM. Nothing is dropped: mail that is not urgent waits for the digest."""

from __future__ import annotations

import re

from .models import HIGH, LOW, NORMAL
from .text import normalize_tr

# Matched against normalize_tr() text, so write the patterns in lower case.
URGENT = re.compile(
    r"\b("
    r"s[ıi]nav\w*|vize\w*|final(?!ly|iz)\w*|b[üu]t[üu]nleme\w*|mazeret\w*|quiz\w*|[öo]dev\w*|proje\w*|teslim\w*|"
    r"son tarih\w*|iptal\w*|ertelen\w*|erteleme\w*|de[ğg]i[şs]ikli[ğg]\w*|acil\w*|zorunlu\w*|"
    r"yoklama\w*|devams[ıi]zl[ıi]k\w*|ders kayd\w*|kay[ıi]t yenile\w*|harç\w*|burs\w*|"
    r"exams?|examination\w*|midterm\w*|assignment\w*|deadline\w*|due date|cancel\w*|postpone\w*|resched\w*|"
    r"urgent|mandatory|makeup|make-up"
    r")\b"
)
CANVAS_SENDER = re.compile(r"instructure|canvas")
BULK_SENDER = re.compile(r"no-?reply|newsletter|b[üu]lten|mailer-daemon")
BULK_HEADERS = ("list-unsubscribe", "list-id")


def mail_level(sender: str, subject: str, body: str, headers: dict[str, str]) -> str:
    sender = normalize_tr(sender)
    if CANVAS_SENDER.search(sender):
        return LOW  # the same news already arrives from the Canvas API
    if URGENT.search(normalize_tr(f"{subject}\n{body[:2000]}")):
        return HIGH
    precedence = headers.get("precedence", "").lower()
    is_bulk = any(name in headers for name in BULK_HEADERS) or precedence in ("bulk", "list", "junk")
    if is_bulk or "auto-submitted" in headers or BULK_SENDER.search(sender):
        return LOW
    return NORMAL
