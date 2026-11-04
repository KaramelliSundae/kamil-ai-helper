"""SQLite state: what has been seen, and an outbox of events still to be delivered.

The outbox is what makes delivery reliable: a watcher run records an event and a later send marks it
done, so a failed send is retried on the next run instead of being lost.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .models import Attachment, Item
from .text import fingerprint

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  course TEXT NOT NULL,
  url TEXT NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  due_at TEXT,
  posted_at TEXT,
  grade TEXT,
  submitted INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS items_due ON items (due_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key TEXT NOT NULL,
  type TEXT NOT NULL,
  level TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS events_unsent ON events (sent_at);
CREATE TABLE IF NOT EXISTS reminders (
  item_key TEXT NOT NULL,
  due_at TEXT NOT NULL,
  hours INTEGER NOT NULL,
  PRIMARY KEY (item_key, due_at, hours)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tainted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  conversation_id INTEGER
);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  untrusted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_reminders (
  id INTEGER PRIMARY KEY,
  due_at TEXT NOT NULL,
  text TEXT NOT NULL,
  fired INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  warnings TEXT NOT NULL DEFAULT ''
);
"""


def to_text(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat(timespec="seconds") if value else None


def to_time(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


@dataclass(frozen=True)
class Change:
    type: str  # new | due_changed | graded | updated
    old_due: datetime | None = None


@dataclass(frozen=True)
class Event:
    id: int
    item_key: str
    type: str
    level: str
    title: str
    body: str
    url: str
    created_at: datetime


def draft_hash(recipient: str, subject: str, body: str) -> str:
    """What the student approves: the send fails if the draft is not exactly what they saw."""
    return hashlib.sha256("\0".join((recipient, subject, body)).encode()).hexdigest()


EVENT_COLUMNS = (
    "item_key TEXT NOT NULL, type TEXT NOT NULL, level TEXT NOT NULL, title TEXT NOT NULL, "
    "body TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT"
)
# Timestamps have whole seconds, so recent use is ordered by the newest message id instead.
BY_ACTIVITY = "(SELECT MAX(id) FROM chat WHERE chat.conversation_id = conversations.id) DESC, id DESC"


class Store:
    def __init__(self, path: Path | str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # The API opens one Store per request, and FastAPI may finish it on another worker thread.
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self._move_old_chat()
        self._add_column("items", "attachments", "TEXT NOT NULL DEFAULT '[]'")
        # Prompt-injection bookkeeping: what untrusted content touched, and where a note or draft came from.
        self._add_column("conversations", "tainted", "INTEGER NOT NULL DEFAULT 0")
        self._add_column("memories", "untrusted", "INTEGER NOT NULL DEFAULT 0")
        self._add_column("drafts", "warnings", "TEXT NOT NULL DEFAULT ''")
        self.db.execute("CREATE INDEX IF NOT EXISTS chat_conversation ON chat (conversation_id)")
        self.db.commit()
        self._never_reuse_event_ids()

    def _never_reuse_event_ids(self) -> None:
        """The phone remembers which event ids it has shown. Without AUTOINCREMENT, deleting the newest event
        hands its id to the next one, which the phone then skips as already seen. Rebuilt once, ids kept."""
        def done() -> bool:
            row = self.db.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'").fetchone()
            return "AUTOINCREMENT" in row["sql"].upper()

        if done():
            return
        self.db.isolation_level = None  # explicit transaction below; the module must not open its own
        try:
            self.db.execute("BEGIN IMMEDIATE")
            if not done():  # another process may have rebuilt it while this one waited
                self.db.execute(f"CREATE TABLE events_rebuilt (id INTEGER PRIMARY KEY AUTOINCREMENT, {EVENT_COLUMNS})")
                self.db.execute("INSERT INTO events_rebuilt SELECT * FROM events")
                self.db.execute("DROP TABLE events")
                self.db.execute("ALTER TABLE events_rebuilt RENAME TO events")
                self.db.execute("CREATE INDEX IF NOT EXISTS events_unsent ON events (sent_at)")
            self.db.execute("COMMIT")
        except sqlite3.Error:
            self.db.execute("ROLLBACK")
            raise
        finally:
            self.db.isolation_level = ""

    def _add_column(self, table: str, column: str, declaration: str) -> None:
        if column not in {row["name"] for row in self.db.execute(f"PRAGMA table_info({table})")}:
            self.db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")

    def _move_old_chat(self) -> None:
        """Chat from before conversations existed becomes one conversation, so nothing is lost."""
        if "conversation_id" not in {row["name"] for row in self.db.execute("PRAGMA table_info(chat)")}:
            self.db.execute("ALTER TABLE chat ADD COLUMN conversation_id INTEGER")
        span = self.db.execute(
            "SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM chat WHERE conversation_id IS NULL"
        ).fetchone()
        if span["first"]:
            cursor = self.db.execute(
                "INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)",
                ("Önceki sohbet", span["first"], span["last"]),
            )
            self.db.execute("UPDATE chat SET conversation_id = ? WHERE conversation_id IS NULL", (cursor.lastrowid,))

    def close(self) -> None:
        self.db.close()

    def get_meta(self, key: str) -> str | None:
        row = self.db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.db.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        self.db.commit()

    def upsert(self, item: Item, now: datetime) -> list[Change]:
        row = self.db.execute("SELECT * FROM items WHERE key = ?", (item.key,)).fetchone()
        stamp, due, posted = to_text(now), to_text(item.due_at), to_text(item.posted_at)
        files = json.dumps([vars(a) for a in item.attachments], ensure_ascii=False)
        if row is None:
            self.db.execute(
                "INSERT INTO items (key, kind, title, course, url, sender, body, due_at, posted_at, grade, "
                "submitted, first_seen, last_seen, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    item.key, item.kind, item.title, item.course, item.url, item.sender, item.body,
                    due, posted, item.grade, int(item.submitted), stamp, stamp, files,
                ),
            )
            self.db.commit()
            return [Change("new")]

        changes: list[Change] = []
        if row["due_at"] != due:
            changes.append(Change("due_changed", to_time(row["due_at"])))
        if item.grade is not None and row["grade"] != item.grade:
            changes.append(Change("graded"))
        if row["title"] != item.title or fingerprint(row["body"]) != fingerprint(item.body):
            changes.append(Change("updated"))
        self.db.execute(
            "UPDATE items SET kind = ?, title = ?, course = ?, url = ?, sender = ?, body = ?, due_at = ?, "
            "posted_at = ?, grade = ?, submitted = ?, last_seen = ?, attachments = ? WHERE key = ?",
            (
                item.kind, item.title, item.course, item.url, item.sender, item.body, due, posted,
                item.grade, int(item.submitted), stamp, files, item.key,
            ),
        )
        self.db.commit()
        return changes

    def add_event(self, item_key: str, type: str, level: str, title: str, body: str, url: str, now: datetime) -> None:
        self.db.execute(
            "INSERT INTO events (item_key, type, level, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (item_key, type, level, title, body, url, to_text(now)),
        )
        self.db.commit()

    def unsent_events(self, levels: tuple[str, ...]) -> list[Event]:
        marks = ", ".join("?" for _ in levels)
        rows = self.db.execute(
            f"SELECT * FROM events WHERE sent_at IS NULL AND level IN ({marks}) ORDER BY id", levels
        ).fetchall()
        return [
            Event(
                r["id"], r["item_key"], r["type"], r["level"], r["title"], r["body"], r["url"],
                to_time(r["created_at"]),
            )
            for r in rows
        ]

    def mark_sent(self, ids: list[int], now: datetime) -> None:
        self.db.executemany("UPDATE events SET sent_at = ? WHERE id = ?", [(to_text(now), i) for i in ids])
        self.db.commit()

    def upcoming(self, start: datetime, end: datetime) -> list[sqlite3.Row]:
        """Work still to do: items with a due date in the window that were not handed in."""
        return self.db.execute(
            "SELECT * FROM items WHERE due_at >= ? AND due_at <= ? AND submitted = 0 ORDER BY due_at",
            (to_text(start), to_text(end)),
        ).fetchall()

    def recent_events(self, limit: int) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()

    @staticmethod
    def attachments(row: sqlite3.Row) -> list[Attachment]:
        try:
            return [Attachment(**entry) for entry in json.loads(row["attachments"] or "[]")]
        except (TypeError, ValueError):
            return []

    def get_item(self, key: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM items WHERE key = ?", (key,)).fetchone()

    def items_of_kind(self, kind: str, since: datetime, course: str | None, limit: int) -> list[sqlite3.Row]:
        query = "SELECT * FROM items WHERE kind = ? AND posted_at >= ?"
        values: list[object] = [kind, to_text(since)]
        if course:
            query += " AND course LIKE ?"
            values.append(f"%{course}%")
        return self.db.execute(query + " ORDER BY posted_at DESC LIMIT ?", (*values, limit)).fetchall()

    def grades(self, course: str) -> list[sqlite3.Row]:
        return self.db.execute(
            "SELECT * FROM items WHERE grade IS NOT NULL AND course LIKE ? ORDER BY due_at", (f"%{course}%",)
        ).fetchall()

    def search_mail(self, query: str, limit: int) -> list[sqlite3.Row]:
        pattern = f"%{query}%"
        return self.db.execute(
            "SELECT * FROM items WHERE kind = 'mail' AND (title LIKE ? OR body LIKE ? OR sender LIKE ?) "
            "ORDER BY posted_at DESC LIMIT ?",
            (pattern, pattern, pattern, limit),
        ).fetchall()

    def new_conversation(self, title: str, now: datetime) -> int:
        cursor = self.db.execute(
            "INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)", (title, to_text(now), to_text(now))
        )
        self.db.commit()
        return cursor.lastrowid

    def conversation(self, conversation_id: int) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()

    def latest_conversation(self) -> int | None:
        row = self.db.execute(f"SELECT id FROM conversations ORDER BY {BY_ACTIVITY} LIMIT 1").fetchone()
        return row["id"] if row else None

    def conversations(self, limit: int) -> list[sqlite3.Row]:
        return self.db.execute(f"SELECT * FROM conversations ORDER BY {BY_ACTIVITY} LIMIT ?", (limit,)).fetchall()

    def delete_conversation(self, conversation_id: int) -> None:
        self.db.execute("DELETE FROM chat WHERE conversation_id = ?", (conversation_id,))
        self.db.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
        self.db.commit()

    def delete_all_conversations(self) -> None:
        self.db.execute("DELETE FROM chat")
        self.db.execute("DELETE FROM conversations")
        self.db.commit()

    def add_chat(self, role: str, content: str, now: datetime, conversation_id: int) -> None:
        self.db.execute(
            "INSERT INTO chat (role, content, created_at, conversation_id) VALUES (?, ?, ?, ?)",
            (role, content, to_text(now), conversation_id),
        )
        self.db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (to_text(now), conversation_id))
        self.db.commit()

    def chat_history(self, conversation_id: int, limit: int) -> list[sqlite3.Row]:
        rows = self.db.execute(
            "SELECT * FROM chat WHERE conversation_id = ? ORDER BY id DESC LIMIT ?", (conversation_id, limit)
        ).fetchall()
        return list(reversed(rows))

    def add_memory(self, text: str, now: datetime, untrusted: bool = False) -> None:
        self.db.execute(
            "INSERT INTO memories (text, created_at, untrusted) VALUES (?, ?, ?)", (text, to_text(now), int(untrusted))
        )
        self.db.commit()

    def memories(self, limit: int) -> list[sqlite3.Row]:
        rows = self.db.execute("SELECT text, untrusted FROM memories ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return list(reversed(rows))

    def is_tainted(self, conversation_id: int | None) -> bool:
        if conversation_id is None:
            return False
        row = self.db.execute("SELECT tainted FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        return bool(row and row["tainted"])

    def mark_tainted(self, conversation_id: int) -> None:
        self.db.execute("UPDATE conversations SET tainted = 1 WHERE id = ?", (conversation_id,))
        self.db.commit()

    def known_sender(self, address: str) -> bool:
        """Whether a stored mail or Canvas item came from this address (taken from its header, not its text)."""
        row = self.db.execute(
            "SELECT 1 FROM items WHERE instr(lower(sender), ?) > 0 LIMIT 1", (address.lower(),)
        ).fetchone()
        return row is not None

    def add_user_reminder(self, due_at: datetime, text: str) -> None:
        self.db.execute("INSERT INTO user_reminders (due_at, text) VALUES (?, ?)", (to_text(due_at), text))
        self.db.commit()

    def due_user_reminders(self, now: datetime) -> list[sqlite3.Row]:
        return self.db.execute(
            "SELECT * FROM user_reminders WHERE fired = 0 AND due_at <= ? ORDER BY due_at", (to_text(now),)
        ).fetchall()

    def mark_user_reminder(self, reminder_id: int) -> None:
        self.db.execute("UPDATE user_reminders SET fired = 1 WHERE id = ?", (reminder_id,))
        self.db.commit()

    def create_draft(
        self, recipient: str, subject: str, body: str, now: datetime, warnings: tuple[str, ...] = ()
    ) -> str:
        draft_id = uuid.uuid4().hex
        self.db.execute(
            "INSERT INTO drafts (id, recipient, subject, body, status, created_at, warnings) "
            "VALUES (?, ?, ?, ?, 'pending', ?, ?)",
            (draft_id, recipient, subject, body, to_text(now), "\n".join(warnings)),
        )
        self.db.commit()
        return draft_id

    def pending_drafts(self) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM drafts WHERE status = 'pending' ORDER BY created_at").fetchall()

    def get_draft(self, draft_id: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM drafts WHERE id = ?", (draft_id,)).fetchone()

    def claim_draft(self, draft_id: str, status: str) -> bool:
        """Moves a pending draft on. Only one caller can win, so a double tap cannot send twice."""
        cursor = self.db.execute(
            "UPDATE drafts SET status = ? WHERE id = ? AND status = 'pending'", (status, draft_id)
        )
        self.db.commit()
        return cursor.rowcount == 1

    def reminder_done(self, item_key: str, due_at: str, hours: int) -> bool:
        row = self.db.execute(
            "SELECT 1 FROM reminders WHERE item_key = ? AND due_at = ? AND hours = ?", (item_key, due_at, hours)
        ).fetchone()
        return row is not None

    def mark_reminders(self, item_key: str, due_at: str, hours: list[int]) -> None:
        self.db.executemany(
            "INSERT OR IGNORE INTO reminders VALUES (?, ?, ?)", [(item_key, due_at, h) for h in hours]
        )
        self.db.commit()
