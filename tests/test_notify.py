from __future__ import annotations

from datetime import UTC, datetime, timedelta

from ai_ders.models import CRITICAL, HIGH, LOW, NORMAL, Item
from ai_ders.notify import build_digest, flush, is_quiet, send_digest

from .conftest import NOW, RecordingNotifier

# 03:00 in Istanbul.
NIGHT = datetime(2026, 11, 3, 0, 0, tzinfo=UTC)


def add(store, level: str, title: str = "Olay", key: str = "k"):
    store.add_event(key, "new", level, title, "", "", NOW)


def test_quiet_hours_use_local_time(settings):
    assert is_quiet(settings, NIGHT)
    assert not is_quiet(settings, NOW)


def test_quiet_window_can_cross_midnight(tmp_path, monkeypatch):
    from ai_ders.config import Settings

    monkeypatch.setenv("AI_DERS_ENV_FILE", str(tmp_path / "missing"))
    wide = Settings.from_env({"QUIET_START": "23", "QUIET_END": "8"})
    assert is_quiet(wide, datetime(2026, 11, 3, 20, 30, tzinfo=UTC))  # 23:30 local
    assert is_quiet(wide, NIGHT)
    assert not is_quiet(wide, NOW)


def test_high_event_waits_for_morning(store, settings, notifier):
    add(store, HIGH)
    assert flush(store, notifier, settings, NIGHT) == 0
    assert notifier.sent == []
    assert flush(store, notifier, settings, NOW) == 1


def test_critical_event_ignores_quiet_hours(store, settings, notifier):
    add(store, CRITICAL, "Son 3 saat")
    assert flush(store, notifier, settings, NIGHT) == 1
    assert notifier.sent[0][0].startswith("[Acil]")


def test_failed_send_keeps_the_event_for_the_next_run(store, settings):
    add(store, HIGH)
    assert flush(store, RecordingNotifier(fail=True), settings, NOW) == 0
    retry = RecordingNotifier()
    assert flush(store, retry, settings, NOW) == 1
    assert len(retry.sent) == 1
    assert flush(store, retry, settings, NOW) == 0


def test_day_old_event_is_not_mailed_late(store, settings, notifier):
    store.add_event("old", "reminder", HIGH, "Dün kalan", "", "", NOW - timedelta(hours=25))
    add(store, HIGH, "Yeni")
    assert flush(store, notifier, settings, NOW) == 1
    assert notifier.sent[0][0] == "Yeni"


def test_a_batch_arrives_as_one_message(store, settings, notifier):
    add(store, HIGH, "Bir")
    add(store, HIGH, "İki")
    flush(store, notifier, settings, NOW)
    subject, body = notifier.sent[0]
    assert subject.startswith("2 yeni bildirim")
    assert "Bir" in body and "İki" in body


def test_normal_mail_waits_for_the_digest(store, settings, notifier):
    add(store, NORMAL, "Sıradan mail")
    add(store, LOW, "Bülten")
    assert flush(store, notifier, settings, NOW) == 0
    assert send_digest(store, notifier, settings, NOW)
    subject, body = notifier.sent[0]
    assert "Sıradan mail" in body
    assert "Toplu ve otomatik mailler: 1" in body
    assert store.unsent_events((NORMAL, LOW)) == []


def test_failed_digest_keeps_its_events(store, settings):
    add(store, NORMAL)
    assert not send_digest(store, RecordingNotifier(fail=True), settings, NOW)
    assert len(store.unsent_events((NORMAL,))) == 1


def test_digest_lists_only_unsubmitted_work_in_the_window(store, settings):
    due = NOW + timedelta(days=2)
    store.upsert(Item(key="a", kind="assignment", title="Açık", course="C", due_at=due), NOW)
    store.upsert(Item(key="b", kind="assignment", title="Teslim", course="C", due_at=due, submitted=True), NOW)
    store.upsert(Item(key="c", kind="assignment", title="Uzak", course="C", due_at=NOW + timedelta(days=30)), NOW)
    _, body, _ = build_digest(store, settings, NOW)
    assert "Açık" in body
    assert "Teslim" not in body and "Uzak" not in body


def test_digest_shows_local_time(store, settings):
    store.upsert(Item(key="a", kind="assignment", title="X", course="C", due_at=NOW + timedelta(days=1)), NOW)
    _, body, _ = build_digest(store, settings, NOW)
    assert "Çar 04.11 15:00" in body


def test_recipient_is_fixed_by_settings(settings):
    from ai_ders.notify import SmtpNotifier

    assert "to" not in SmtpNotifier.send.__code__.co_varnames
    assert settings.notify_email == "me@example.com"
