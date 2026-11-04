"""Delivering events to the student.

The recipient of a notification comes only from settings, never from a caller, so no content can steer
one to somebody else. The one exception is send_approved_draft(), reached only through the app's approval.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from datetime import datetime, timedelta
from email.message import EmailMessage
from typing import Protocol

from .config import Settings
from .models import CRITICAL, HIGH, LOW, NORMAL
from .store import Event, Store, to_time
from .text import shorten

log = logging.getLogger(__name__)

DIGEST_DAYS = 7
SECTION_LIMIT = 40
STALE_AFTER = timedelta(hours=24)
WEEKDAYS = ("Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz")


class Notifier(Protocol):
    def send(self, subject: str, body: str) -> None: ...


class SmtpNotifier:
    def __init__(self, settings: Settings):
        self.settings = settings

    def send(self, subject: str, body: str) -> None:
        settings = self.settings
        message = EmailMessage()
        message["From"] = settings.mail_user
        message["To"] = settings.notify_email
        message["Subject"] = subject
        message.set_content(body)
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as smtp:
            smtp.starttls(context=ssl.create_default_context())
            smtp.login(settings.mail_user, settings.mail_password)
            smtp.send_message(message)


def send_approved_draft(settings: Settings, recipient: str, subject: str, body: str) -> None:
    message = EmailMessage()
    message["From"] = settings.mail_user
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(body)
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as smtp:
        smtp.starttls(context=ssl.create_default_context())
        smtp.login(settings.mail_user, settings.mail_password)
        smtp.send_message(message)


class ConsoleNotifier:
    """Prints instead of sending, for --dry-run."""

    def send(self, subject: str, body: str) -> None:
        print(f"--- {subject}\n{body}\n")


def is_quiet(settings: Settings, now: datetime) -> bool:
    hour = now.astimezone(settings.timezone).hour
    start, end = settings.quiet_start, settings.quiet_end
    return start <= hour < end if start <= end else hour >= start or hour < end


def format_time(settings: Settings, value: datetime) -> str:
    local = value.astimezone(settings.timezone)
    return f"{WEEKDAYS[local.weekday()]} {local:%d.%m %H:%M}"


def render_event(event: Event) -> str:
    lines = [event.title]
    if event.body:
        lines.append(event.body)
    if event.url:
        lines.append(event.url)
    return "\n".join(lines)


def flush(store: Store, notifier: Notifier, settings: Settings, now: datetime) -> int:
    """Sends what is due now, in one message. On failure events stay in the outbox for the next run."""
    levels = (CRITICAL,) if is_quiet(settings, now) else (CRITICAL, HIGH)
    # Older events stay in the app. Mailed a day late, for example once mail is set up, they would mislead.
    events = [event for event in store.unsent_events(levels) if now - event.created_at <= STALE_AFTER]
    if not events:
        return 0
    urgent = any(event.level == CRITICAL for event in events)
    prefix = "[Acil] " if urgent else ""
    subject = shorten(f"{prefix}{events[0].title}", 120)
    if len(events) > 1:
        subject = f"{prefix}{len(events)} yeni bildirim: {shorten(events[0].title, 80)}"
    try:
        notifier.send(subject, "\n\n".join(render_event(event) for event in events))
    except Exception as error:  # noqa: BLE001 - any send failure means: keep the events and retry
        log.error("notification not sent, will retry: %s", error)
        return 0
    store.mark_sent([event.id for event in events], now)
    return len(events)


def build_digest(store: Store, settings: Settings, now: datetime) -> tuple[str, str, list[int]]:
    upcoming = store.upcoming(now, now + timedelta(days=DIGEST_DAYS))
    waiting = store.unsent_events((NORMAL, LOW))
    normal = [event for event in waiting if event.level == NORMAL]
    low = [event for event in waiting if event.level == LOW]

    sections: list[str] = []
    if upcoming:
        lines = [
            f"- {format_time(settings, to_time(row['due_at']))}  {row['course']}: {row['title']}"
            for row in upcoming[:SECTION_LIMIT]
        ]
        sections.append(f"Önümüzdeki {DIGEST_DAYS} gün ({len(upcoming)})\n" + "\n".join(lines))
    else:
        sections.append(f"Önümüzdeki {DIGEST_DAYS} günde teslim bekleyen bir şey yok.")
    if normal:
        lines = [f"- {event.title}" for event in normal[:SECTION_LIMIT]]
        sections.append(f"Diğer mailler ({len(normal)})\n" + "\n".join(lines))
    if low:
        sections.append(f"Toplu ve otomatik mailler: {len(low)}")

    local = now.astimezone(settings.timezone)
    subject = f"Günlük özet {local:%d.%m}: {len(upcoming)} teslim, {len(normal)} mail"
    return subject, "\n\n".join(sections), [event.id for event in waiting]


def send_digest(store: Store, notifier: Notifier, settings: Settings, now: datetime) -> bool:
    subject, body, ids = build_digest(store, settings, now)
    try:
        notifier.send(subject, body)
    except Exception as error:  # noqa: BLE001 - see flush()
        log.error("digest not sent: %s", error)
        return False
    store.mark_sent(ids, now)
    return True
