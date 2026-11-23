from __future__ import annotations

import json
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from ai_ders.api import create_app, event_json
from ai_ders.models import Item
from ai_ders.spam import THRESHOLD, score_mail
from ai_ders.store import Store
from ai_ders.watcher import ingest

from .conftest import NOW


class FakeLlm:
    def __init__(self, content):
        self.content = content
        self.calls = 0

    def chat(self, messages, tools):
        self.calls += 1
        return {"content": self.content}


@pytest.fixture
def api_settings(settings):
    return replace(settings, api_token="dogru")


@pytest.fixture
def db(api_settings):
    store = Store(api_settings.db_path)
    yield store
    store.close()


def suspicious() -> Item:
    return Item(
        key="mail:5:1", kind="mail", title="Hesabınız Askıya Alınacak",
        sender="Okul Bilgi İşlem <it@secure-verify.example>",
        body="Hesabınız hemen doğrulanmalı, derhal https://secure-verify.example/login adresinden işlem yapın.",
        posted_at=NOW,
    )


def fake_event_row() -> dict:
    return {"id": 1, "item_key": "x", "type": "mail", "level": "normal", "title": "x", "body": "x", "url": "", "created_at": "x", "read_at": None}


def test_ingest_scores_a_suspicious_mail_and_the_event_shows_it(store, api_settings):
    count = ingest(store, api_settings, [suspicious()], NOW, baseline=False)
    assert count == 1
    row = store.get_item("mail:5:1")
    assert row["spam_score"] >= THRESHOLD
    reasons = json.loads(row["spam_reasons"])
    assert reasons
    out = event_json(fake_event_row(), row, api_settings.school_domain)
    assert out["spam"] == {"reasons": reasons}


def test_turning_the_filter_off_skips_scoring_entirely(store, api_settings):
    store.set_meta("spam_filter_enabled", "0")
    ingest(store, api_settings, [suspicious()], NOW, baseline=False)
    row = store.get_item("mail:5:1")
    assert row["spam_score"] == 0.0 and row["spam_reasons"] == "[]"
    assert event_json(fake_event_row(), row, api_settings.school_domain)["spam"] is None


def test_a_normal_known_school_mail_is_not_flagged_by_ingest(store, api_settings):
    item = Item(
        key="mail:5:2", kind="mail", title="Vize Tarihi", sender="Hoca <h@uni.example.edu>",
        body="Vize 25 Kasım'da.", posted_at=NOW, message_id="<a@uni.example.edu>",
    )
    ingest(store, api_settings, [item], NOW, baseline=False)
    row = store.get_item("mail:5:2")
    assert row["spam_score"] < THRESHOLD
    assert event_json(fake_event_row(), row, api_settings.school_domain)["spam"] is None


def test_spam_filter_toggle_endpoint_defaults_on_and_can_be_turned_off(api_settings, db):
    client = TestClient(create_app(api_settings, FakeLlm(""), object()))
    headers = {"Authorization": "Bearer dogru"}
    assert client.get("/v1/settings/spam-filter", headers=headers).json() == {"enabled": True}
    assert client.post("/v1/settings/spam-filter", json={"enabled": False}, headers=headers).json() == {"enabled": False}
    assert client.get("/v1/settings/spam-filter", headers=headers).json() == {"enabled": False}


def test_spam_check_refines_once_and_is_cached(api_settings, db):
    db.upsert(suspicious(), NOW)
    result = score_mail(
        "Okul Bilgi İşlem <it@secure-verify.example>", "x", "x https://secure-verify.example/login",
        True, False, api_settings.school_domain, {"someoneelse@uni.example.edu"},
    )
    db.set_spam("mail:5:1", result.score, result.reasons)
    llm = FakeLlm(json.dumps({"score": 0.95, "reasons": ["model gerekçesi"]}))
    client = TestClient(create_app(api_settings, llm, object()))
    headers = {"Authorization": "Bearer dogru"}

    first = client.post("/v1/mail/spam-check", json={"key": "mail:5:1"}, headers=headers).json()
    assert first["score"] == 0.95 and "model gerekçesi" in first["reasons"]
    assert llm.calls == 1

    second = client.post("/v1/mail/spam-check", json={"key": "mail:5:1"}, headers=headers).json()
    assert second["score"] == 0.95
    assert llm.calls == 1  # cached: the model is not asked twice


def test_spam_check_never_asks_the_model_below_threshold(api_settings, db):
    db.upsert(Item(key="mail:5:3", kind="mail", title="x", sender="h@uni.example.edu", body="x", posted_at=NOW), NOW)
    db.set_spam("mail:5:3", 0.1, ("zayıf bir sinyal",))
    llm = FakeLlm(json.dumps({"score": 0.9, "reasons": ["x"]}))
    client = TestClient(create_app(api_settings, llm, object()))
    headers = {"Authorization": "Bearer dogru"}
    result = client.post("/v1/mail/spam-check", json={"key": "mail:5:3"}, headers=headers).json()
    assert result["score"] == 0.1
    assert llm.calls == 0
