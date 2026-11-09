"""Adds events the student approved to their Google Calendar. It uses the same refresh token as Google Tasks, and only
when the student connected with `--calendar`: the scope is `calendar.events`, which can add and change events but
reads no other part of the account. Nothing here is ever called without the student choosing an event first.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import httpx

from .gtasks import CALENDAR_SCOPE, GoogleCredentials, GoogleTasksError, access_token

EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
DEFAULT_MINUTES = 60  # an event with a start and no end


def has_calendar(credentials: GoogleCredentials) -> bool:
    return CALENDAR_SCOPE in credentials.scopes


class GoogleCalendar:
    def __init__(self, credentials: GoogleCredentials, timezone: str, client: httpx.Client | None = None):
        self.credentials = credentials
        self.timezone = timezone
        self.client = client or httpx.Client(timeout=20.0)

    def body(self, title: str, start: str, end: str | None, location: str | None, notes: str) -> dict:
        """`start` is a day (2026-11-14) for an event with no hour, or a day and time (2026-11-14T14:00)."""
        event: dict = {"summary": title}
        if location:
            event["location"] = location
        if notes:
            event["description"] = notes
        if len(start) == 10:
            last = date.fromisoformat(end or start)
            event["start"] = {"date": start}
            event["end"] = {"date": (last + timedelta(days=1)).isoformat()}  # Google's end day is exclusive
        else:
            begin = datetime.fromisoformat(start)
            finish = datetime.fromisoformat(end) if end else begin + timedelta(minutes=DEFAULT_MINUTES)
            event["start"] = {"dateTime": begin.isoformat(timespec="seconds"), "timeZone": self.timezone}
            event["end"] = {"dateTime": finish.isoformat(timespec="seconds"), "timeZone": self.timezone}
        return event

    def add(self, title: str, start: str, end: str | None, location: str | None, notes: str) -> str:
        response = self.client.post(
            EVENTS_URL,
            json=self.body(title, start, end, location, notes),
            headers={"Authorization": f"Bearer {access_token(self.client, self.credentials)}"},
        )
        if response.status_code == 403:
            raise GoogleTasksError("Google takvime izin vermedi: Calendar API'si açık mı, bağlantı --calendar ile mi kuruldu?")
        response.raise_for_status()
        return response.json()["id"]
