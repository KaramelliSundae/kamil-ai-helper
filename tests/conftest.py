from __future__ import annotations

from datetime import UTC, datetime

import pytest

from ai_ders.config import Settings
from ai_ders.store import Store

# 15:00 in Istanbul: outside quiet hours.
NOW = datetime(2026, 11, 3, 12, 0, tzinfo=UTC)


@pytest.fixture
def settings(tmp_path, monkeypatch) -> Settings:
    monkeypatch.setenv("AI_DERS_ENV_FILE", str(tmp_path / "missing"))
    return Settings.from_env(
        {"STATE_DIR": str(tmp_path), "MAIL_USER": "ogrenci@uni.example.edu", "NOTIFY_EMAIL": "me@example.com"}
    )


@pytest.fixture
def store(settings) -> Store:
    store = Store(settings.db_path)
    yield store
    store.close()


class RecordingNotifier:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.sent: list[tuple[str, str]] = []

    def send(self, subject: str, body: str) -> None:
        if self.fail:
            raise OSError("smtp down")
        self.sent.append((subject, body))


@pytest.fixture
def notifier() -> RecordingNotifier:
    return RecordingNotifier()
