from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from ai_ders.api import create_app
from ai_ders.gcalendar import EVENTS_URL, GoogleCalendar, has_calendar
from ai_ders.gtasks import CALENDAR_SCOPE, SCOPE, TOKEN_URL, GoogleCredentials, GoogleTasksError
from ai_ders.models import Item
from ai_ders.store import Store
from ai_ders.suggest import clean_event, parse_events, suggest_events

from .conftest import NOW
from .test_api import AUTH, Sends

TODAY = date(2026, 11, 9)


def day(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


def test_events_are_read_and_made_safe():
    reply = json.dumps({"events": [
        {"title": "BİL 205: Lab sınavı", "start": f"{day(3)}T14:00", "end": f"{day(3)}T15:30", "location": "B-204"},
        {"title": "Kulüp toplantısı", "start": day(5), "end": None, "location": "https://evil.example/x"},
        {"title": "Geçmiş", "start": day(-2)},
        {"title": "Tarihsiz"},
        {"title": "Bağlantı https://evil.example", "start": day(2)},
        {"title": "BİL 205: Lab sınavı", "start": f"{day(3)}T14:00"},  # the same one twice
    ]})
    events = parse_events(f"<think>x</think>{reply}", TODAY)
    assert events == [
        {"title": "BİL 205: Lab sınavı", "start": f"{day(3)}T14:00", "end": f"{day(3)}T15:30", "location": "B-204"},
        {"title": "Kulüp toplantısı", "start": day(5), "end": None, "location": None},
    ]


@pytest.mark.parametrize("junk", ["", "not json", "{}", '{"events": 5}', '{"events": ["x", 3, null]}'])
def test_unreadable_answers_are_no_events(junk):
    assert parse_events(junk, TODAY) == []


def test_an_end_that_makes_no_sense_is_dropped_not_the_event():
    before = clean_event({"title": "A", "start": f"{day(1)}T14:00", "end": f"{day(1)}T13:00"}, TODAY)
    far = clean_event({"title": "A", "start": f"{day(1)}T14:00", "end": f"{day(9)}T13:00"}, TODAY)
    mixed = clean_event({"title": "A", "start": f"{day(1)}T14:00", "end": day(1)}, TODAY)
    assert before["end"] is None and far["end"] is None and mixed["end"] is None
    assert clean_event({"title": "A", "start": day(1), "end": day(3)}, TODAY)["end"] == day(3)
    assert clean_event({"title": "A", "start": day(400)}, TODAY) is None  # too far ahead to be believed


def test_the_model_sees_the_text_fenced_and_with_no_tools():
    seen = {}

    class Llm:
        def chat(self, messages, tools):
            seen["messages"], seen["tools"] = messages, tools
            return {"content": json.dumps({"events": [{"title": "T", "start": day(1)}]})}

    events = suggest_events(Llm(), "Konu", "BİL 205", "Hoca", "Cuma 14.00'te lab sınavı", TODAY)
    assert events and seen["tools"] == []
    assert "guvenilmeyen_icerik" in seen["messages"][1]["content"] and "Pazartesi" in seen["messages"][0]["content"]


CREDS = GoogleCredentials("id", "secret", "refresh", (SCOPE, CALENDAR_SCOPE))


def calendar_for(handler) -> GoogleCalendar:
    return GoogleCalendar(CREDS, "Europe/Istanbul", httpx.Client(transport=httpx.MockTransport(handler)))


def test_old_connections_have_no_calendar_and_new_ones_say_so():
    old = GoogleCredentials.parse(json.dumps({"client_id": "a", "client_secret": "b", "refresh_token": "c"}))
    assert not has_calendar(old) and has_calendar(CREDS)
    assert GoogleCredentials.parse(json.dumps({"client_id": "id", "client_secret": "secret", "refresh_token": "refresh", "scopes": [SCOPE, CALENDAR_SCOPE]})) == CREDS


def test_a_timed_event_and_an_all_day_event_reach_google_in_its_own_form():
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_URL:
            return httpx.Response(200, json={"access_token": "tok"})
        assert str(request.url) == EVENTS_URL and request.headers["Authorization"] == "Bearer tok"
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"id": f"ev{len(sent)}"})

    calendar = calendar_for(handler)
    assert calendar.add("Lab sınavı", "2026-11-12T14:00", None, "B-204", "Kamil: BİL 205") == "ev1"
    assert calendar.add("Kulüp", "2026-11-13", "2026-11-14", None, "") == "ev2"
    assert sent[0] == {
        "summary": "Lab sınavı", "location": "B-204", "description": "Kamil: BİL 205",
        "start": {"dateTime": "2026-11-12T14:00:00", "timeZone": "Europe/Istanbul"},
        "end": {"dateTime": "2026-11-12T15:00:00", "timeZone": "Europe/Istanbul"},  # no end given: an hour
    }
    assert sent[1] == {"summary": "Kulüp", "start": {"date": "2026-11-13"}, "end": {"date": "2026-11-15"}}  # Google's end day is exclusive


def test_a_refused_calendar_says_what_to_check():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "t"}) if str(request.url) == TOKEN_URL else httpx.Response(403)

    with pytest.raises(GoogleTasksError, match="Calendar API"):
        calendar_for(handler).add("x", "2026-11-12", None, None, "")


class FakeCalendar:
    def __init__(self):
        self.added = []

    def add(self, title, start, end, location, notes):
        self.added.append((title, start, end, location, notes))
        return f"id{len(self.added)}"


class Llm:
    def chat(self, messages, tools):
        soon = (datetime.now(UTC) + timedelta(days=2)).date().isoformat()
        return {"content": json.dumps({"events": [{"title": "BİL 205: Lab", "start": f"{soon}T14:00", "location": "B-204"}]})}


@pytest.fixture
def setup(settings):
    settings = replace(settings, api_token="dogru")
    store = Store(settings.db_path)
    store.upsert(Item(key="mail:1", kind="mail", title="Lab saati", course="", sender="Hoca", body="Cuma 14.00'te lab"), NOW)
    calendar = FakeCalendar()
    yield TestClient(create_app(settings, Llm(), Sends(), None, calendar)), calendar, store
    store.close()


def test_the_app_is_told_the_calendar_is_there(setup, settings):
    client, _, _ = setup
    assert client.get("/v1/chat/setup", headers=AUTH).json()["features"]["calendar"] is True
    bare = TestClient(create_app(replace(settings, api_token="dogru"), Llm(), Sends()))
    assert bare.get("/v1/chat/setup", headers=AUTH).json()["features"]["calendar"] is False
    bare_store = Store(replace(settings, api_token="dogru").db_path)
    bare_store.upsert(Item(key="mail:2", kind="mail", title="Lab", body="x"), NOW)
    bare_store.close()
    assert bare.post("/v1/calendar/suggest", json={"key": "mail:2"}, headers=AUTH).status_code == 200  # the phone can still open its calendar
    assert bare.post("/v1/calendar", json={"key": "mail:2", "title": "T", "start": day(1)}, headers=AUTH).status_code == 409


def test_suggest_adds_nothing_and_a_chosen_event_goes_in_once(setup):
    client, calendar, _ = setup
    options = client.post("/v1/calendar/suggest", json={"key": "mail:1"}, headers=AUTH).json()["events"]
    assert len(options) == 1 and calendar.added == []
    chosen = {"key": "mail:1", **options[0]}
    assert client.post("/v1/calendar", json=chosen, headers=AUTH).json() == {"status": "added"}
    assert client.post("/v1/calendar", json=chosen, headers=AUTH).json() == {"status": "exists"}
    assert calendar.added == [("BİL 205: Lab", options[0]["start"], None, "B-204", "Kamil: Lab saati")]


def test_an_event_with_a_link_or_a_past_day_is_refused_and_an_unknown_item_is_a_404(setup):
    client, calendar, _ = setup
    link = {"key": "mail:1", "title": "Gel https://evil.example", "start": day(1)}
    past = {"key": "mail:1", "title": "Eski", "start": "2020-01-01"}
    assert client.post("/v1/calendar", json=link, headers=AUTH).status_code == 422
    assert client.post("/v1/calendar", json=past, headers=AUTH).status_code == 422
    assert client.post("/v1/calendar", json={**link, "key": "mail:404"}, headers=AUTH).status_code == 404
    assert calendar.added == []
