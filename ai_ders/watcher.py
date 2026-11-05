"""One polling round. Uses no LLM, so deadlines keep working when the model is off or the GPU is busy.

Each source fails on its own: Canvas being down never stops mail or reminders. A source that keeps
failing raises an alert, because a silently expired token is exactly how things would get missed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .canvas import CanvasAuthError, CanvasClient, CanvasError
from .config import Settings
from .mailbox import Cursor, Mailbox
from .models import CRITICAL, HIGH, Item
from .notify import format_time
from .store import Change, Store, to_text, to_time
from .text import shorten

log = logging.getLogger(__name__)

ANNOUNCEMENT_DAYS = 30
PLANNER_DAYS = 60
MAIL_HISTORY_DAYS = 14  # read quietly on the first run
FAILURES_BEFORE_ALERT = 6  # one hour at the 10 minute timer
PREVIEW_CHARS = 280
KIND_LABELS = {
    "assignment": "Yeni ödev",
    "quiz": "Yeni quiz",
    "discussion": "Yeni tartışma",
    "event": "Yeni etkinlik",
    "announcement": "Duyuru",
    "message": "Canvas mesajı",
    "mail": "Mail",
}


@dataclass
class PollResult:
    items: int = 0
    events: int = 0
    errors: list[str] = field(default_factory=list)


def label(item: Item) -> str:
    return f"{item.course}: {item.title}" if item.course else item.title


def deadline_level(settings: Settings, due: datetime | None, now: datetime) -> str:
    urgent = due is not None and now <= due <= now + timedelta(hours=settings.critical_hours)
    return CRITICAL if urgent else HIGH


def item_details(settings: Settings, item: Item) -> str:
    parts = []
    if item.due_at:
        parts.append(f"Son tarih: {format_time(settings, item.due_at)}")
    if item.sender:
        parts.append(f"Kimden: {item.sender}")
    if item.body:
        parts.append(shorten(item.body, PREVIEW_CHARS))
    return "\n".join(parts)


def record_change(store: Store, settings: Settings, item: Item, change: Change, now: datetime) -> None:
    details = item_details(settings, item)
    if change.type == "new":
        level = item.level if item.kind == "mail" else deadline_level(settings, item.due_at, now)
        title = f"{KIND_LABELS.get(item.kind, 'Yeni')}: {label(item)}"
    elif change.type == "due_changed":
        level = deadline_level(settings, item.due_at, now)
        old = format_time(settings, change.old_due) if change.old_due else "yoktu"
        new = format_time(settings, item.due_at) if item.due_at else "kaldırıldı"
        title = f"Tarih değişti: {label(item)}"
        details = f"Eski: {old}\nYeni: {new}"
    elif change.type == "graded":
        level = HIGH
        title = f"Not girildi: {label(item)}"
        details = f"Not: {item.grade}"
    else:
        level = HIGH
        title = f"Güncellendi: {label(item)}"
    store.add_event(item.key, change.type, level, title, details, item.url, now)


def ingest(store: Store, settings: Settings, items: list[Item], now: datetime, baseline: bool) -> int:
    """Stores items and records what changed. A baseline run only learns the current state."""
    count = 0
    for item in items:
        for change in store.upsert(item, now):
            if not baseline:
                record_change(store, settings, item, change, now)
                count += 1
    return count


def poll_canvas(canvas: CanvasClient, now: datetime) -> list[Item]:
    courses = canvas.courses()
    items: list[Item] = []
    for course_id, name in courses.items():
        items.extend(canvas.assignments(course_id, name))
    items.extend(canvas.announcements(courses, now - timedelta(days=ANNOUNCEMENT_DAYS), now))
    items.extend(canvas.planner_items(courses, now - timedelta(days=1), now + timedelta(days=PLANNER_DAYS)))
    items.extend(canvas.messages())
    # Assignments come first, so a task also listed in the planner keeps its fuller record.
    return list({item.key: item for item in reversed(items)}.values())


def record_failure(store: Store, source: str, error: Exception, now: datetime, immediate: bool = False) -> None:
    key = f"{source}_failures"
    failures = int(store.get_meta(key) or 0) + 1
    store.set_meta(key, str(failures))
    log.warning("%s failed (%d in a row): %s", source, failures, error)
    if failures == FAILURES_BEFORE_ALERT or (immediate and failures == 1):
        title = f"{source} takibi çalışmıyor"
        store.add_event(f"system:{source}", "alert", CRITICAL, title, str(error), "", now)


def clear_failure(store: Store, source: str) -> None:
    if store.get_meta(f"{source}_failures") not in (None, "0"):
        store.set_meta(f"{source}_failures", "0")


def add_reminders(store: Store, settings: Settings, now: datetime) -> int:
    """One message per item however many thresholds it crossed: a late-added task gets the nearest."""
    horizon = now + timedelta(hours=max(settings.reminder_hours))
    count = 0
    for row in store.upcoming(now, horizon):
        due = to_time(row["due_at"])
        crossed = [h for h in settings.reminder_hours if now >= due - timedelta(hours=h)]
        pending = [h for h in crossed if not store.reminder_done(row["key"], row["due_at"], h)]
        if not pending:
            continue
        store.mark_reminders(row["key"], row["due_at"], pending)
        hours = min(pending)
        level = CRITICAL if hours <= settings.critical_hours else HIGH
        name = f"{row['course']}: {row['title']}" if row["course"] else row["title"]
        title = f"{hours} saat kaldı: {name}"
        body = f"Son tarih: {format_time(settings, due)}"
        store.add_event(row["key"], "reminder", level, title, body, row["url"], now)
        count += 1
    return count


def fire_user_reminders(store: Store, now: datetime) -> int:
    rows = store.due_user_reminders(now)
    for row in rows:
        store.add_event(f"reminder:{row['id']}", "reminder", HIGH, f"Hatırlatma: {row['text']}", "", "", now)
        store.mark_user_reminder(row["id"])
    return len(rows)


def run_poll(store: Store, settings: Settings, canvas: CanvasClient | None, mailbox: Mailbox | None, now: datetime) -> PollResult:
    result = PollResult()

    if canvas is not None:
        try:
            items = poll_canvas(canvas, now)
        except CanvasAuthError as error:
            record_failure(store, "Canvas", error, now, immediate=True)
            result.errors.append(str(error))
        except (CanvasError, ValueError) as error:
            record_failure(store, "Canvas", error, now)
            result.errors.append(str(error))
        else:
            baseline = store.get_meta("canvas_baseline") is None
            result.events += ingest(store, settings, items, now, baseline)
            result.items += len(items)
            store.set_meta("canvas_baseline", to_text(now))
            clear_failure(store, "Canvas")

    if mailbox is not None:
        raw = store.get_meta("mail_cursor")
        cursor = Cursor(*map(int, raw.split(":"))) if raw else None
        try:
            if cursor is None:
                items, new_cursor = mailbox.fetch_recent(now - timedelta(days=MAIL_HISTORY_DAYS))
            else:
                items, new_cursor = mailbox.fetch_new(cursor)
        except Exception as error:  # noqa: BLE001 - imaplib raises many unrelated types
            record_failure(store, "Mail", error, now)
            result.errors.append(str(error))
        else:
            result.events += ingest(store, settings, items, now, baseline=cursor is None)
            result.items += len(items)
            store.set_meta("mail_cursor", f"{new_cursor.uidvalidity}:{new_cursor.last_uid}")
            clear_failure(store, "Mail")

    result.events += add_reminders(store, settings, now)
    result.events += fire_user_reminders(store, now)
    store.set_meta("last_poll_at", to_text(now))
    return result
