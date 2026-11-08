"""Which mails belong to one conversation: the same rules as the app's mobile/src/mailThread.ts, so a
conversation groups the same way whether the phone or the server read the mail. Also where the student's own
side of it is kept, the Sent folder. Light on purpose: the sending sandbox imports this and nothing that parses."""

from __future__ import annotations

import re
from typing import Any

REPLY_PREFIX = re.compile(r"^\s*(?:re|fw|fwd|ynt|yan[ıi]t|cvp|cevap|ilt|[iİ]let)\s*(?:\[\d+\])?\s*[:：]\s*", re.IGNORECASE)
MESSAGE_ID = re.compile(r"<[^<>\s]+>")
MOST_REFERENCES = 10  # the newest few name the conversation well enough, and a header stays short
# The same names the phone looks for (AngusMail.kt) when a server doesn't mark its Sent folder.
SENT_NAMES = ("Sent", "Sent Items", "Sent Messages", "INBOX.Sent", "Gönderilmiş", "Gönderilenler", "Gönderilmiş Öğeler")


def turkish_lower(text: str) -> str:
    """What JavaScript's toLocaleLowerCase('tr') gives, so "IŞIK" and "ışık" are one subject on both sides."""
    return text.replace("I", "ı").replace("İ", "i").lower()


def plain_subject(subject: str) -> str:
    """ "Re: Ynt: Vize" is the same conversation as "Vize"."""
    text = subject
    while REPLY_PREFIX.match(text):
        text = REPLY_PREFIX.sub("", text, count=1)
    return turkish_lower(text.strip())


def message_ids(text: str | None) -> list[str]:
    return MESSAGE_ID.findall(text or "")


def first_message_id(text: str | None) -> str:
    found = message_ids(text)
    return found[0] if found else ""


def thread_of(headers: dict[str, str], subject: str) -> str:
    """The first mail of the conversation, as its headers name it. Without any, the subject decides."""
    for name in ("references", "in-reply-to", "message-id"):
        if found := first_message_id(headers.get(name)):
            return found
    return f"s:{plain_subject(subject)}"


def reply_references(references: str | None, in_reply_to: str | None) -> str:
    """References for a reply: the conversation so far plus the mail being answered, newest last."""
    return " ".join((message_ids(references) + message_ids(in_reply_to))[-MOST_REFERENCES:])


def reply_subject(subject: str) -> str:
    return subject if re.match(r"^\s*re\s*:", subject, re.IGNORECASE) else f"Re: {subject}"


def find_sent_folder(folders: list[Any]) -> str | None:
    """The folder the server marks as Sent (RFC 6154), else the first with a familiar name, else none."""
    for folder in folders:
        if any(flag.lower() == "\\sent" for flag in folder.flags):
            return folder.name
    for name in SENT_NAMES:
        for folder in folders:
            if folder.name.lower() == name.lower() or folder.name.rsplit(folder.delim or "/", 1)[-1].lower() == name.lower():
                return folder.name
    return None
