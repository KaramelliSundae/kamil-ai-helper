from __future__ import annotations

from datetime import datetime, timedelta

from ai_ders.canvas import CanvasAuthError, CanvasError
from ai_ders.mailbox import Cursor
from ai_ders.models import CRITICAL, HIGH, LOW, Item
from ai_ders.watcher import FAILURES_BEFORE_ALERT, MAIL_HISTORY_DAYS, add_reminders, poll_canvas, run_poll

from .conftest import NOW


class FakeCanvas:
    def __init__(self, assignments=(), announcements=(), planner=(), error: Exception | None = None):
        self.assignments_list = list(assignments)
        self.announcements_list = list(announcements)
        self.planner_list = list(planner)
        self.error = error

    def courses(self):
        if self.error:
            raise self.error
        return {1: "COMP303"}

    def assignments(self, course_id, course):
        return self.assignments_list

    def announcements(self, courses, start, end):
        return self.announcements_list

    def planner_items(self, courses, start, end):
        return self.planner_list

    def messages(self):
        return []


class FakeMailbox:
    def __init__(self, items=(), error: Exception | None = None, recent=()):
        self.items = list(items)
        self.recent = list(recent)
        self.error = error
        self.cursors: list[Cursor] = []
        self.since: list[datetime] = []

    def fetch_recent(self, since):
        self.since.append(since)
        if self.error:
            raise self.error
        return self.recent, Cursor(5, 100)

    def fetch_new(self, cursor):
        self.cursors.append(cursor)
        if self.error:
            raise self.error
        return self.items, Cursor(5, cursor.last_uid + len(self.items))


def assignment(key="assignment:1", due: datetime | None = None, **fields) -> Item:
    return Item(key=key, kind="assignment", title="HW1", course="COMP303", due_at=due, **fields)


def events(store):
    return store.unsent_events((CRITICAL, HIGH, "normal", LOW))


def baseline(store, settings, canvas):
    run_poll(store, settings, canvas, None, NOW)
    store.mark_sent([e.id for e in events(store)], NOW)


def test_first_run_learns_the_state_without_announcing_old_items(store, settings):
    old = Item(key="announcement:1", kind="announcement", title="Eski")
    run_poll(store, settings, FakeCanvas([assignment()], [old]), None, NOW)
    assert events(store) == []


def test_new_assignment_after_baseline_is_announced(store, settings):
    baseline(store, settings, FakeCanvas([]))
    due = NOW + timedelta(days=10)
    run_poll(store, settings, FakeCanvas([assignment(due=due)]), None, NOW)
    assert [(e.type, e.level) for e in events(store)] == [("new", HIGH)]
    assert "Yeni ödev: COMP303: HW1" in events(store)[0].title


def test_nothing_is_announced_twice(store, settings):
    baseline(store, settings, FakeCanvas([]))
    canvas = FakeCanvas([assignment(due=NOW + timedelta(days=10))])
    run_poll(store, settings, canvas, None, NOW)
    run_poll(store, settings, canvas, None, NOW + timedelta(minutes=10))
    assert len(events(store)) == 1


def test_changed_due_date_is_reported_with_both_dates(store, settings):
    first = NOW + timedelta(days=10)
    baseline(store, settings, FakeCanvas([assignment(due=first)]))
    run_poll(store, settings, FakeCanvas([assignment(due=first + timedelta(days=2))]), None, NOW)
    event = events(store)[0]
    assert event.type == "due_changed"
    assert "Eski:" in event.body and "Yeni:" in event.body


def test_new_grade_is_reported_once(store, settings):
    baseline(store, settings, FakeCanvas([assignment()]))
    graded = FakeCanvas([assignment(grade="90", submitted=True)])
    run_poll(store, settings, graded, None, NOW)
    run_poll(store, settings, graded, None, NOW)
    assert [(e.type, e.body) for e in events(store)] == [("graded", "Not: 90")]


def test_edited_announcement_is_reported(store, settings):
    item = Item(key="announcement:1", kind="announcement", title="Sınav", body="Salı")
    baseline(store, settings, FakeCanvas(announcements=[item]))
    edited = Item(key="announcement:1", kind="announcement", title="Sınav", body="Perşembe")
    run_poll(store, settings, FakeCanvas(announcements=[edited]), None, NOW)
    assert [e.type for e in events(store)] == ["updated"]


def test_task_listed_in_both_sources_counts_once():
    task = Item(key="quiz:9", kind="quiz", title="Q", body="fuller")
    planner = Item(key="quiz:9", kind="quiz", title="Q")
    items = poll_canvas(FakeCanvas([task], planner=[planner]), NOW)
    assert [i.body for i in items if i.key == "quiz:9"] == ["fuller"]


def test_reminder_fires_at_each_threshold_once(store, settings):
    due = NOW + timedelta(hours=100)
    baseline(store, settings, FakeCanvas([assignment(due=due)]))

    def reminders_at(hours_left: float):
        add_reminders(store, settings, due - timedelta(hours=hours_left))
        found = [e for e in events(store) if e.type == "reminder"]
        store.mark_sent([e.id for e in found], NOW)
        return [(e.title.split(" ")[0], e.level) for e in found]

    assert reminders_at(80) == []
    assert reminders_at(71) == [("72", HIGH)]
    assert reminders_at(70) == []
    assert reminders_at(23) == [("24", HIGH)]
    assert reminders_at(2.5) == [("3", CRITICAL)]
    assert reminders_at(1) == []


def test_late_task_gets_one_reminder_not_three(store, settings):
    baseline(store, settings, FakeCanvas([]))
    run_poll(store, settings, FakeCanvas([assignment(due=NOW + timedelta(hours=2))]), None, NOW)
    reminders = [e for e in events(store) if e.type == "reminder"]
    assert len(reminders) == 1
    assert reminders[0].title.startswith("3 saat kaldı")
    assert [e.level for e in events(store) if e.type == "new"] == [CRITICAL]


def test_submitted_work_is_not_reminded(store, settings):
    due = NOW + timedelta(hours=2)
    baseline(store, settings, FakeCanvas([assignment(due=due, submitted=True)]))
    assert [e for e in events(store) if e.type == "reminder"] == []


def test_moved_deadline_starts_its_reminders_again(store, settings):
    due = NOW + timedelta(hours=2)
    baseline(store, settings, FakeCanvas([assignment(due=due)]))
    run_poll(store, settings, FakeCanvas([assignment(due=due + timedelta(minutes=30))]), None, NOW)
    assert len([e for e in events(store) if e.type == "reminder"]) == 1


def test_canvas_outage_does_not_stop_mail_or_reminders(store, settings):
    due = NOW + timedelta(hours=2)
    baseline(store, settings, FakeCanvas([assignment(due=due)]))
    mail = Item(key="mail:5:101", kind="mail", title="Vize", level=HIGH)
    box = FakeMailbox()
    run_poll(store, settings, None, box, NOW)  # sets the cursor
    box.items = [mail]
    result = run_poll(store, settings, FakeCanvas(error=CanvasError("down")), box, NOW)
    assert len(result.errors) == 1
    assert [e.type for e in events(store)] == ["new"]


def test_mail_outage_does_not_stop_canvas(store, settings):
    baseline(store, settings, FakeCanvas([]))
    canvas = FakeCanvas([assignment(due=NOW + timedelta(days=9))])
    run_poll(store, settings, canvas, FakeMailbox(error=OSError("imap down")), NOW)
    assert [e.type for e in events(store)] == ["new"]


def test_mail_level_decides_the_event_level(store, settings):
    box = FakeMailbox()
    run_poll(store, settings, None, box, NOW)
    box.items = [Item(key="mail:5:101", kind="mail", title="Bülten", level=LOW)]
    run_poll(store, settings, None, box, NOW)
    assert [e.level for e in events(store)] == [LOW]


def test_cursor_survives_between_runs(store, settings):
    box = FakeMailbox()
    run_poll(store, settings, None, box, NOW)
    run_poll(store, settings, None, box, NOW)
    assert box.since == [NOW - timedelta(days=MAIL_HISTORY_DAYS)]
    assert box.cursors == [Cursor(5, 100)]


def test_first_mail_run_keeps_recent_mail_without_notifying(store, settings):
    old = Item(key="mail:5:90", kind="mail", title="Vize tarihi", level=HIGH, body="Vize Salı")
    run_poll(store, settings, None, FakeMailbox(recent=[old]), NOW)
    assert events(store) == []
    assert [row["key"] for row in store.search_mail("Vize", 10)] == ["mail:5:90"]


def test_failed_first_mail_run_tries_the_history_again(store, settings):
    run_poll(store, settings, None, FakeMailbox(error=OSError("imap down")), NOW)
    box = FakeMailbox()
    run_poll(store, settings, None, box, NOW)
    assert len(box.since) == 1 and box.cursors == []


def test_refused_token_alerts_at_once_and_only_once(store, settings):
    canvas = FakeCanvas(error=CanvasAuthError("Canvas refused the token"))
    run_poll(store, settings, canvas, None, NOW)
    run_poll(store, settings, canvas, None, NOW)
    assert [(e.type, e.level) for e in events(store)] == [("alert", CRITICAL)]


def test_repeated_outage_alerts_after_an_hour_not_on_the_first_blip(store, settings):
    canvas = FakeCanvas(error=CanvasError("down"))
    for _ in range(FAILURES_BEFORE_ALERT - 1):
        run_poll(store, settings, canvas, None, NOW)
    assert events(store) == []
    run_poll(store, settings, canvas, None, NOW)
    run_poll(store, settings, canvas, None, NOW)
    assert [e.type for e in events(store)] == ["alert"]


def test_recovery_resets_the_outage_count(store, settings):
    for _ in range(FAILURES_BEFORE_ALERT - 1):
        run_poll(store, settings, FakeCanvas(error=CanvasError("down")), None, NOW)
    run_poll(store, settings, FakeCanvas(), None, NOW)
    run_poll(store, settings, FakeCanvas(error=CanvasError("down")), None, NOW)
    assert events(store) == []



def test_a_deleted_newest_event_never_hands_its_id_to_the_next(store):
    store.add_event("a", "new", HIGH, "Bir", "", "", NOW)
    store.add_event("b", "new", HIGH, "İki", "", "", NOW)
    newest = store.db.execute("SELECT MAX(id) FROM events").fetchone()[0]
    store.db.execute("DELETE FROM events WHERE id = ?", (newest,))
    store.db.commit()
    store.add_event("c", "new", HIGH, "Üç", "", "", NOW)
    assert store.db.execute("SELECT MAX(id) FROM events").fetchone()[0] == newest + 1


def test_old_events_table_is_rebuilt_with_its_ids(settings):
    import sqlite3

    from ai_ders.store import Store

    old = sqlite3.connect(settings.db_path)
    old.execute(
        "CREATE TABLE events (id INTEGER PRIMARY KEY, item_key TEXT NOT NULL, type TEXT NOT NULL, level TEXT NOT NULL, "
        "title TEXT NOT NULL, body TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT)"
    )
    old.execute("INSERT INTO events VALUES (7, 'k', 'new', 'high', 'Eski', '', '', '2026-11-01T00:00:00+00:00', NULL)")
    old.commit()
    old.close()
    store = Store(settings.db_path)
    assert [(e.id, e.title) for e in store.unsent_events((HIGH,))] == [(7, "Eski")]
    store.db.execute("DELETE FROM events WHERE id = 7")
    store.db.commit()
    store.add_event("k2", "new", HIGH, "Yeni", "", "", NOW)
    assert store.db.execute("SELECT MAX(id) FROM events").fetchone()[0] == 8
    store.close()
    Store(settings.db_path).close()  # a second open leaves the rebuilt table alone


def test_old_items_table_gains_attachments_and_keeps_its_rows(settings):
    import sqlite3

    from ai_ders.store import Store

    old = sqlite3.connect(settings.db_path)
    old.execute(
        "CREATE TABLE items (key TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, course TEXT NOT NULL, "
        "url TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, due_at TEXT, posted_at TEXT, grade TEXT, "
        "submitted INTEGER NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL)"
    )
    old.execute("INSERT INTO items VALUES ('mail:5:1', 'mail', 'Eski', '', '', '', 'Metin', NULL, NULL, NULL, 0, 'x', 'x')")
    old.commit()
    old.close()
    store = Store(settings.db_path)
    row = store.get_item("mail:5:1")
    assert row["body"] == "Metin" and Store.attachments(row) == []
    store.close()
