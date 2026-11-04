"""Read-only access to the school mailbox over IMAP.

The folder is opened read-only and bodies are fetched with BODY.PEEK, so a mail the student has not
read stays unread. IMAP logs in per connection, so webmail session timeouts do not apply.
"""

from __future__ import annotations

import logging
import os
import re
import ssl
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

from imap_tools import AND, MailBox, U

from .mailparse import MAX_INPUT_BYTES, MailParseError, ParsedMail, Parser
from .models import NORMAL, Item
from .rules import mail_level

log = logging.getLogger(__name__)

FOLDER = "INBOX"
MAX_PER_POLL = 100
MAX_BODY_BYTES = MAX_INPUT_BYTES
UNREADABLE = "(açılamayan mail)"


@dataclass(frozen=True)
class Cursor:
    uidvalidity: int
    last_uid: int


def mail_item(parsed: ParsedMail, uid: int, uidvalidity: int, now: datetime) -> Item:
    subject = parsed.subject or "(konusuz)"
    return Item(
        key=f"mail:{uidvalidity}:{uid}",
        kind="mail",
        title=subject,
        sender=parsed.sender or parsed.from_,
        body=parsed.body.strip(),
        posted_at=parsed.date or now,
        level=mail_level(parsed.from_, subject, parsed.body, parsed.headers),
        attachments=parsed.attachments,
    )


class Mailbox:
    """IMAP only moves bytes here. Every mail is read by `parser`, which on the server is the sandbox."""

    def __init__(
        self,
        host: str,
        port: int,
        user: str,
        password: str,
        parser: Parser,
        image_dir: Path | None = None,
        factory: Callable[..., Any] = MailBox,
    ):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.parser = parser
        self.image_dir = image_dir
        self.factory = factory

    def _connect(self) -> Any:
        box = self.factory(host=self.host, port=self.port, timeout=60, ssl_context=ssl.create_default_context())
        box.login(self.user, self.password, initial_folder=None)
        box.folder.set(FOLDER, readonly=True)
        return box

    def check(self) -> dict[str, int]:
        box = self._connect()
        try:
            return box.folder.status(FOLDER, ["MESSAGES", "UNSEEN"])
        finally:
            box.logout()

    def fetch_new(self, cursor: Cursor | None) -> tuple[list[Item], Cursor]:
        """Returns mail newer than the cursor. Without a cursor it starts from now and returns nothing."""
        box = self._connect()
        try:
            status = box.folder.status(FOLDER, ["UIDVALIDITY", "UIDNEXT"])
            uidvalidity, uidnext = int(status["UIDVALIDITY"]), int(status["UIDNEXT"])
            # A new UIDVALIDITY means the server renumbered the folder: old UIDs mean nothing now.
            if cursor is None or cursor.uidvalidity != uidvalidity:
                if cursor is not None:
                    log.warning("mailbox UIDVALIDITY changed; continuing from the newest mail")
                return [], Cursor(uidvalidity, uidnext - 1)

            last = cursor.last_uid
            # "n:*" always matches the newest mail, even when n is past it, hence the filter.
            uids = sorted(uid for uid in map(int, box.uids(AND(uid=U(str(last + 1), "*")))) if uid > last)
            uids = uids[:MAX_PER_POLL]
            return self._items(box, uids, uidvalidity), Cursor(uidvalidity, uids[-1] if uids else last)
        finally:
            box.logout()

    def fetch_recent(self, since: datetime) -> tuple[list[Item], Cursor]:
        """For a first run: the newest mail since a date, so the agent can answer about the last days."""
        box = self._connect()
        try:
            status = box.folder.status(FOLDER, ["UIDVALIDITY", "UIDNEXT"])
            uidvalidity, uidnext = int(status["UIDVALIDITY"]), int(status["UIDNEXT"])
            uids = sorted(map(int, box.uids(AND(date_gte=since.date()))))[-MAX_PER_POLL:]
            # Mail that arrived after STATUS is in this batch already, so the next run must not fetch it again.
            last = max([uidnext - 1, *uids])
            return self._items(box, uids, uidvalidity), Cursor(uidvalidity, last)
        finally:
            box.logout()

    def _items(self, box: Any, uids: list[int], uidvalidity: int) -> list[Item]:
        now = datetime.now(UTC)
        items: list[Item] = []
        for uid in uids:
            # A mail too big for the sandbox is still listed, from its header alone.
            part = "BODY.PEEK[HEADER]" if self._size(box, uid) > MAX_BODY_BYTES else "BODY.PEEK[]"
            raw = self._raw(box, uid, part)
            try:
                parsed = self.parser(raw)
            except MailParseError as error:
                log.warning("mail %s could not be read: %s", uid, error)
                items.append(Item(key=f"mail:{uidvalidity}:{uid}", kind="mail", title=UNREADABLE, posted_at=now, level=NORMAL))
                continue
            self._keep_images(parsed)
            items.append(mail_item(parsed, uid, uidvalidity, now))
        return items

    @staticmethod
    def _fetch(box: Any, uid: int, what: str) -> list[Any]:
        # PEEK, on a folder opened read-only: reading never marks a mail as seen.
        status, data = box.client.uid("FETCH", str(uid), f"({what})")
        if status != "OK":
            raise OSError(f"IMAP FETCH {what} failed for {uid}")
        return data

    def _size(self, box: Any, uid: int) -> int:
        for entry in self._fetch(box, uid, "RFC822.SIZE"):
            line = entry[0] if isinstance(entry, tuple) else entry
            if isinstance(line, bytes) and (found := re.search(rb"RFC822\.SIZE (\d+)", line)):
                return int(found.group(1))
        return 0

    def _raw(self, box: Any, uid: int, part: str) -> bytes:
        for entry in self._fetch(box, uid, part):
            if isinstance(entry, tuple) and len(entry) == 2 and isinstance(entry[1], bytes):
                return entry[1]
        return b""

    def _keep_images(self, parsed: ParsedMail) -> None:
        """Writes the sandbox's clean JPEGs, named by their hash, for the phone to ask for."""
        if self.image_dir is None or not parsed.images:
            return
        self.image_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        for sha, data in parsed.images.items():
            target = self.image_dir / f"{sha}.jpg"
            if target.exists():
                continue
            partial = target.with_suffix(".part")
            partial.write_bytes(data)
            os.replace(partial, target)
