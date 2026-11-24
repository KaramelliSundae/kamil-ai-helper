"""Read-only access to the school mailbox over IMAP.

The folder is opened read-only and bodies are fetched with BODY.PEEK, so a mail the student has not
read stays unread. IMAP logs in per connection, so webmail session timeouts do not apply.
"""

from __future__ import annotations

import logging
import os
import poplib
import re
import ssl
import time
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

from imap_tools import AND, MailBox, U

from .mailparse import MAX_INPUT_BYTES, MailParseError, ParsedMail, Parser, SandboxUnavailable
from .mailthread import find_sent_folder, first_message_id, thread_of
from .models import NORMAL, Item
from .rules import is_bulk_mail, mail_level

log = logging.getLogger(__name__)

FOLDER = "INBOX"
# The school's IMAP proxy occasionally drops the connection with no reply while still checking a login
# (seen as "socket error: EOF" right after LOGIN); a prompt retry on a fresh connection clears it.
LOGIN_ATTEMPTS = 3
LOGIN_RETRY_DELAY = 2.0
POP3_PORT = 995
MAX_PER_POLL = 100
# Each mail is read in its own sandbox (about 1.5 s in a microVM), and the student's own mails are only the other half of
# each conversation: a few per round keeps the whole poll well inside its time limit, and the cursor catches up.
MAX_SENT_PER_POLL = 20
MAX_BODY_BYTES = MAX_INPUT_BYTES
UNREADABLE = "(açılamayan mail)"
# Mail the student sent, so a conversation shows both sides. The app knows these by this prefix.
OUTGOING_PREFIX = "mail:out:"


@dataclass(frozen=True)
class Cursor:
    """How far IMAP has read. Both numbers mean nothing once UIDVALIDITY changes (a renumbered folder)."""
    uidvalidity: int
    last_uid: int


@dataclass(frozen=True)
class Pop3Cursor:
    """How far the POP3 fallback has read. `last_item_id` is the numeric prefix of a UIDL (e.g. the 3469
    in "3469.CHyBBD..."), confirmed stable across sessions and strictly increasing with arrival order on
    this server — so it works exactly like an IMAP UID, with no UIDVALIDITY equivalent to track."""
    last_item_id: int


def encode_cursor(cursor: Cursor | Pop3Cursor) -> str:
    if isinstance(cursor, Pop3Cursor):
        return f"pop3:{cursor.last_item_id}"
    return f"imap:{cursor.uidvalidity}:{cursor.last_uid}"


def decode_cursor(raw: str) -> Cursor | Pop3Cursor:
    parts = raw.split(":")
    if parts[0] == "pop3":
        return Pop3Cursor(int(parts[1]))
    if parts[0] == "imap":
        return Cursor(int(parts[1]), int(parts[2]))
    return Cursor(int(parts[0]), int(parts[1]))  # a cursor saved before POP3 fallback existed


def mail_item(parsed: ParsedMail, key: str, now: datetime) -> Item:
    subject = parsed.subject or "(konusuz)"
    return Item(
        key=key,
        kind="mail",
        title=subject,
        sender=parsed.sender or parsed.from_,
        body=parsed.body.strip(),
        posted_at=parsed.date or now,
        level=mail_level(parsed.from_, subject, parsed.body, parsed.headers),
        attachments=parsed.attachments,
        thread=thread_of(parsed.headers, parsed.subject),
        # Not the Reply-To header: anyone can write there, and a reply should go to who it seems to come from.
        reply_to=parsed.from_,
        message_id=first_message_id(parsed.headers.get("message-id")),
        references=parsed.headers.get("references", ""),
        bulk=is_bulk_mail(parsed.from_, parsed.headers),
    )


def sent_item(parsed: ParsedMail, key: str, now: datetime) -> Item:
    """One of the student's own mails, as the other half of a conversation: never a row of its own."""
    return Item(
        key=key,
        kind="mail",
        title=parsed.subject or "(konusuz)",
        sender="Sen",
        body=parsed.body.strip(),
        posted_at=parsed.date or now,
        level=NORMAL,
        attachments=parsed.attachments,
        thread=thread_of(parsed.headers, parsed.subject),
        reply_to=parsed.to,
        message_id=first_message_id(parsed.headers.get("message-id")),
        references=parsed.headers.get("references", ""),
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
        pop3_port: int = POP3_PORT,
        pop3_factory: Callable[..., Any] = poplib.POP3_SSL,
    ):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.parser = parser
        self.image_dir = image_dir
        self.factory = factory
        self.pop3_port = pop3_port
        self.pop3_factory = pop3_factory

    def _connect(self, folder: str | None = FOLDER) -> Any:
        last_error: Exception | None = None
        for attempt in range(LOGIN_ATTEMPTS):
            if attempt:
                time.sleep(LOGIN_RETRY_DELAY)
            box = self.factory(host=self.host, port=self.port, timeout=60, ssl_context=ssl.create_default_context())
            try:
                box.login(self.user, self.password, initial_folder=None)
            except Exception as error:  # noqa: BLE001 - imaplib raises several unrelated types on a dropped login
                last_error = error
                with suppress(Exception):
                    box.logout()
                log.warning("mail login attempt %d/%d failed: %s", attempt + 1, LOGIN_ATTEMPTS, error)
                continue
            if folder is not None:
                box.folder.set(folder, readonly=True)
            return box
        raise last_error

    def check(self) -> dict[str, int]:
        box = self._connect()
        try:
            return box.folder.status(FOLDER, ["MESSAGES", "UNSEEN"])
        finally:
            box.logout()

    def fetch_sent(self, cursor: Cursor | None, since: datetime, mode: str = "auto") -> tuple[list[Item], Cursor] | None:
        """The student's own mails since the cursor, or since `since` on a first run. None when this mailbox
        has no Sent folder: that's only the other half of each conversation, and the inbox goes on without it.
        POP3 has no folder concept at all, so a forced POP3 mode is the same as "no Sent folder"."""
        if mode == "pop3":
            return None
        box = self._connect(folder=None)
        try:
            folder = find_sent_folder(list(box.folder.list()))
            if folder is None:
                return None
            box.folder.set(folder, readonly=True)
            status = box.folder.status(folder, ["UIDVALIDITY", "UIDNEXT"])
            uidvalidity, uidnext = int(status["UIDVALIDITY"]), int(status["UIDNEXT"])
            if cursor is None or cursor.uidvalidity != uidvalidity:
                uids = sorted(map(int, box.uids(AND(date_gte=since.date()))))[-MAX_SENT_PER_POLL:]
                last = max([uidnext - 1, *uids])
            else:
                uids = sorted(uid for uid in map(int, box.uids(AND(uid=U(str(cursor.last_uid + 1), "*")))) if uid > cursor.last_uid)
                uids = uids[:MAX_SENT_PER_POLL]
                last = uids[-1] if uids else cursor.last_uid
            return self._items(box, uids, uidvalidity, outgoing=True), Cursor(uidvalidity, last)
        finally:
            box.logout()

    def fetch_new(
        self, cursor: Cursor | Pop3Cursor | None, mode: str = "auto", since: datetime | None = None,
    ) -> tuple[list[Item], Cursor | Pop3Cursor]:
        """Returns mail newer than the cursor. Without a cursor it starts from now and returns nothing.
        `mode`: "auto" tries IMAP first and only falls back to POP3 if IMAP itself fails this round; "pop3"
        skips IMAP entirely (a manual override, or IMAP already known to be down). Crossing from a POP3
        cursor back to IMAP re-reads the last `since` instead of jumping to "now", so nothing in between is
        missed — duplicates against what POP3 already delivered are caught by the Message-ID check in
        `watcher.ingest`, not here."""
        if mode == "auto":
            try:
                if isinstance(cursor, Pop3Cursor) and since is not None:
                    return self._fetch_recent_imap(since)
                return self._fetch_new_imap(cursor if isinstance(cursor, Cursor) else None)
            except SandboxUnavailable:
                raise  # the mail-parsing sandbox is down, not IMAP: POP3 would hit the same wall
            except Exception as error:  # noqa: BLE001 - imaplib raises several unrelated types
                log.warning("mail: IMAP unavailable this round, falling back to POP3: %s", error)
        return self._fetch_pop3(cursor.last_item_id if isinstance(cursor, Pop3Cursor) else None)

    def _fetch_new_imap(self, cursor: Cursor | None) -> tuple[list[Item], Cursor]:
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

    def fetch_recent(self, since: datetime, mode: str = "auto") -> tuple[list[Item], Cursor | Pop3Cursor]:
        """For a first run: the newest mail since a date, so the agent can answer about the last days."""
        if mode == "auto":
            try:
                return self._fetch_recent_imap(since)
            except SandboxUnavailable:
                raise  # the mail-parsing sandbox is down, not IMAP: POP3 would hit the same wall
            except Exception as error:  # noqa: BLE001 - imaplib raises several unrelated types
                log.warning("mail: IMAP unavailable this round, falling back to POP3: %s", error)
        return self._fetch_pop3(None)

    def _fetch_recent_imap(self, since: datetime) -> tuple[list[Item], Cursor]:
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

    def _items(self, box: Any, uids: list[int], uidvalidity: int, outgoing: bool = False) -> list[Item]:
        entries = []
        for uid in uids:
            # A mail too big for the sandbox is still listed, from its header alone.
            part = "BODY.PEEK[HEADER]" if self._size(box, uid) > MAX_BODY_BYTES else "BODY.PEEK[]"
            key = f"{OUTGOING_PREFIX if outgoing else 'mail:'}{uidvalidity}:{uid}"
            entries.append((key, self._raw(box, uid, part)))
        return self._parsed_items(entries, outgoing)

    def _parsed_items(self, entries: list[tuple[str, bytes]], outgoing: bool = False) -> list[Item]:
        """`entries`: (item key, raw RFC822 bytes) pairs, already fetched. Shared by the IMAP and POP3 paths
        so sandboxing and item shape never drift between them."""
        now = datetime.now(UTC)
        items: list[Item] = []
        for key, raw in entries:
            try:
                parsed = self.parser(raw)
            except MailParseError as error:
                log.warning("mail %s could not be read: %s", key, error)
                if not outgoing:  # an unreadable mail of one's own adds nothing to a conversation
                    items.append(Item(key=key, kind="mail", title=UNREADABLE, posted_at=now, level=NORMAL))
                continue
            self._keep_images(parsed)
            items.append((sent_item if outgoing else mail_item)(parsed, key, now))
        return items

    # ---- POP3 fallback, used only while IMAP is unreachable (or a forced override). The numeric prefix of a
    # UIDL (e.g. the 3469 in "3469.CHyBBD...") was confirmed stable across sessions and strictly increasing
    # with arrival order on this server, so it is tracked exactly like an IMAP UID.

    def _pop3_connect(self) -> Any:
        pop = self.pop3_factory(self.host, self.pop3_port, timeout=60, context=ssl.create_default_context())
        try:
            pop.user(self.user)
            pop.pass_(self.password)
        except Exception:
            with suppress(Exception):
                pop.quit()
            raise
        return pop

    @staticmethod
    def _pop3_item_id(uidl: str) -> int:
        return int(uidl.split(".", 1)[0])

    def _pop3_rows(self, pop: Any) -> list[tuple[int, int, int]]:
        """(sequence number, item id, size in bytes), in the server's own order."""
        sizes: dict[str, int] = {}
        for line in pop.list()[1]:
            seq, size = line.decode().split()
            sizes[seq] = int(size)
        rows = []
        for line in pop.uidl()[1]:
            seq, uidl = line.decode().split(" ", 1)
            rows.append((int(seq), self._pop3_item_id(uidl), sizes.get(seq, 0)))
        return rows

    def _pop3_raw(self, pop: Any, seq: int, size: int) -> bytes:
        # TOP ... 0 mirrors BODY.PEEK[HEADER] on the IMAP side: a mail too big for the sandbox is still
        # listed, from its header alone. Neither TOP nor RETR marks a mail as read: POP3 has no such flag.
        _, lines, _ = pop.top(seq, 0) if size > MAX_BODY_BYTES else pop.retr(seq)
        return b"\r\n".join(lines)

    def _fetch_pop3(self, last_item_id: int | None) -> tuple[list[Item], Pop3Cursor]:
        pop = self._pop3_connect()
        try:
            rows = self._pop3_rows(pop)
            if last_item_id is None:
                # No usable cursor (first run, or just crossed over from IMAP): the newest mail only, since
                # POP3 cannot filter by date without fetching every header.
                rows = rows[-MAX_PER_POLL:]
            else:
                rows = [row for row in rows if row[1] > last_item_id][:MAX_PER_POLL]
            entries = [(f"mail:pop3:{item_id}", self._pop3_raw(pop, seq, size)) for seq, item_id, size in rows]
            newest = max((item_id for _, item_id, _ in rows), default=last_item_id or 0)
            return self._parsed_items(entries), Pop3Cursor(max(newest, last_item_id or 0))
        finally:
            with suppress(Exception):
                pop.quit()

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
