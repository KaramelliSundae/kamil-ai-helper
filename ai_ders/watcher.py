"""One polling round. Uses no LLM, so deadlines keep working when the model is off or the GPU is busy.

Each source fails on its own: Canvas being down never stops mail or reminders. A source that keeps
failing raises an alert, because a silently expired token is exactly how things would get missed.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from . import exams
from .canvas import CanvasAuthError, CanvasClient, CanvasError
from .config import Settings
from .docparse import read_here
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
TASK_MOVED = "Google Tasks'taki görev eski tarihte. Bugün ekranından güncelleyebilirsin."
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
        if store.get_meta(f"gtask:{item.key}"):
            details += f"\n{TASK_MOVED}"
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


EXAM_NAMES = {"midterm": "Vize", "final": "Final"}
EXAM_SCAN_SECONDS = 120.0  # one round does this much; courses it did not reach wait for the next


def _exam_name(found: exams.Found) -> str:
    return EXAM_NAMES[found.kind] + (f" {found.number}" if found.number else "")


def record_exams(store: Store, settings: Settings, course: str, found: list[exams.Found], now: datetime, quiet: bool) -> int:
    """Stores what was found. Only a firm date is worth a notification, and the very first scan stays quiet."""
    events = 0
    for item in found:
        change = store.put_exam(course, item, exams.TRUST, now)
        key = f"exam:{course}:{item.kind}:{item.number}"
        in_tasks = store.get_meta(f"gtask:{key}") is not None
        # Any date is worth a word once it is in the student's Tasks, however unsure it is.
        if change and not quiet and (item.status == exams.ANNOUNCED or in_tasks):
            day = item.starts_on.strftime("%d.%m.%Y")
            verb = "tarihi değişti" if change == "moved" or item.status != exams.ANNOUNCED else "tarihi açıklandı"
            note = f"\n{TASK_MOVED}" if in_tasks else ""
            store.add_event(key, "exam", HIGH, f"{course}: {_exam_name(item)} {verb}", f"Tarih: {day}{note}\n{item.evidence}", item.url, now)
            events += 1
    return events


def update_exams(store: Store, settings: Settings, canvas: CanvasClient, items: list[Item], read_document, now: datetime) -> int:
    """Announcements and Canvas's own items every round, since they are at hand. Syllabi cost more: every course once, then
    weekly only for courses whose syllabus has not appeared yet, because it often goes up weeks into the term."""
    today = now.astimezone(settings.timezone).date()
    first_run = store.get_meta("exams_baseline") is None
    known = {row["course"]: row for row in store.exam_courses()}
    starts = {name: date.fromisoformat(row["term_start"]) for name, row in known.items() if row["term_start"]}
    events = 0
    for course, found in exams.exams_in_items(items, today, starts).items():
        events += record_exams(store, settings, course, exams.best(found, today), now, first_run)

    every = int(store.get_meta("syllabus_check_days") or exams.DEFAULT_CHECK_DAYS)
    if not every:
        store.set_meta("exams_baseline", to_text(now))
        return events
    began = time.monotonic()
    finished = True
    for course_id, course in canvas.courses().items():
        row = store.exam_course(course_id)
        if row is not None and (row["has_syllabus"] or now - to_time(row["checked_at"]) < timedelta(days=every)):
            continue
        if time.monotonic() - began > EXAM_SCAN_SECONDS:
            finished = False
            break
        try:
            scan = exams.scan_course(canvas, course_id, today, read_document)
        except CanvasAuthError:
            raise
        except CanvasError as error:
            log.warning("could not scan a course for exams: %s", error)
            continue
        store.put_exam_course(course_id, course, scan.term_start.isoformat() if scan.term_start else None, scan.has_syllabus, scan.hint, now, scan.attendance)
        events += record_exams(store, settings, course, scan.found, now, first_run)
    if finished:
        store.set_meta("exams_baseline", to_text(now))
    return events


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


def run_poll(
    store: Store, settings: Settings, canvas: CanvasClient | None, mailbox: Mailbox | None, now: datetime, read_document=None,
) -> PollResult:
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
            try:
                result.events += update_exams(store, settings, canvas, items, read_document or read_here, now)
            except Exception:  # noqa: BLE001 - the deadlines above are in; exam dates can always wait for the next round
                log.exception("exam scan failed")

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
