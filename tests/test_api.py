from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from ai_ders.api import create_app
from ai_ders.llm import LlmBusy
from ai_ders.models import Item
from ai_ders.store import Store, draft_hash

from .conftest import NOW

AUTH = {"Authorization": "Bearer dogru"}


class Sends:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls = []

    def __call__(self, settings, recipient, subject, body):
        if self.fail:
            raise OSError("smtp down")
        self.calls.append((recipient, subject, body))


class Llm:
    def chat(self, messages, tools):
        return {"content": "Cevap"}


@pytest.fixture
def api_settings(settings):
    return replace(settings, api_token="dogru")


@pytest.fixture
def sends():
    return Sends()


@pytest.fixture
def client(api_settings, sends):
    return TestClient(create_app(api_settings, Llm(), sends))


@pytest.fixture
def db(api_settings):
    store = Store(api_settings.db_path)
    yield store
    store.close()


ROUTES = [
    ("get", "/v1/today"), ("get", "/v1/events"), ("get", "/v1/chat"), ("post", "/v1/chat"), ("get", "/v1/drafts"),
    ("post", "/v1/drafts/x/send"), ("post", "/v1/drafts/x/discard"), ("get", "/v1/gpu"), ("post", "/v1/gpu"),
    ("get", "/v1/app/latest"), ("get", "/v1/app/apk"), ("get", "/v1/items/mail:5:101"),
    ("get", "/v1/images/" + "a" * 64), ("get", "/v1/settings/gemini"), ("put", "/v1/settings/gemini"),
    ("delete", "/v1/settings/gemini"), ("get", "/v1/settings/gemini/models"),
    ("get", "/v1/conversations"), ("get", "/v1/conversations/1"), ("delete", "/v1/conversations/1"),
    ("delete", "/v1/conversations"), ("post", "/v1/tasks"), ("post", "/v1/tasks/suggest"), ("post", "/v1/tasks/update"), ("post", "/v1/tasks/keep"), ("post", "/v1/tasks/remove"), ("post", "/v1/gpu/priority"), ("get", "/v1/chat/progress/abcdefgh"), ("post", "/v1/events/refresh"), ("delete", "/v1/events/1"), ("get", "/v1/chat/setup"),
]


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_route_needs_the_token(client, method, path):
    assert getattr(client, method)(path).status_code == 401
    assert getattr(client, method)(path, headers={"Authorization": "Bearer yanlis"}).status_code == 401


def test_no_token_configured_locks_everything(settings, sends):
    client = TestClient(create_app(replace(settings, api_token=None), Llm(), sends))
    assert client.get("/v1/events", headers={"Authorization": "Bearer None"}).status_code == 401


def test_api_docs_are_not_served(client):
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_chat_answers(client):
    reply = client.post("/v1/chat", json={"text": "Selam"}, headers=AUTH).json()
    assert reply["reply"] == "Cevap" and reply["conversationId"]
    assert [m["role"] for m in client.get("/v1/chat", headers=AUTH).json()] == ["user", "assistant"]


def test_new_chat_starts_a_conversation_and_an_id_continues_it(client):
    first = client.post("/v1/chat", json={"text": "Birinci", "new": True}, headers=AUTH).json()["conversationId"]
    second = client.post("/v1/chat", json={"text": "İkinci", "new": True}, headers=AUTH).json()["conversationId"]
    again = client.post("/v1/chat", json={"text": "Devam", "conversationId": first}, headers=AUTH).json()
    assert first != second and again["conversationId"] == first
    listed = client.get("/v1/conversations", headers=AUTH).json()
    assert [c["id"] for c in listed] == [first, second]  # most recently used first
    detail = client.get(f"/v1/conversations/{first}", headers=AUTH).json()
    assert [m["content"] for m in detail["messages"]] == ["Birinci", "Cevap", "Devam", "Cevap"]


def test_old_app_without_an_id_continues_the_latest_conversation(client):
    first = client.post("/v1/chat", json={"text": "Bir"}, headers=AUTH).json()["conversationId"]
    assert client.post("/v1/chat", json={"text": "İki"}, headers=AUTH).json()["conversationId"] == first


def test_conversations_can_be_deleted_one_or_all(client):
    one = client.post("/v1/chat", json={"text": "Bir", "new": True}, headers=AUTH).json()["conversationId"]
    client.post("/v1/chat", json={"text": "İki", "new": True}, headers=AUTH)
    client.delete(f"/v1/conversations/{one}", headers=AUTH)
    assert len(client.get("/v1/conversations", headers=AUTH).json()) == 1
    assert client.get(f"/v1/conversations/{one}", headers=AUTH).status_code == 404
    client.delete("/v1/conversations", headers=AUTH)
    assert client.get("/v1/conversations", headers=AUTH).json() == []


def test_chat_in_a_deleted_conversation_is_a_404(client):
    assert client.post("/v1/chat", json={"text": "Selam", "conversationId": 999}, headers=AUTH).status_code == 404


def test_busy_model_is_a_clear_503(api_settings, sends):
    class Busy:
        def chat(self, messages, tools):
            raise LlmBusy("GPU başka bir işte")

    client = TestClient(create_app(api_settings, Busy(), sends))
    response = client.post("/v1/chat", json={"text": "Selam"}, headers=AUTH)
    assert response.status_code == 503 and "GPU" in response.json()["detail"]


def test_empty_message_is_refused(client):
    assert client.post("/v1/chat", json={"text": ""}, headers=AUTH).status_code == 422


def test_approved_draft_is_sent_exactly_once(client, db, sends):
    draft_id = db.create_draft("hoca@uni.example.edu", "Konu", "Metin", NOW)
    draft = client.get("/v1/drafts", headers=AUTH).json()[0]
    path = f"/v1/drafts/{draft_id}/send"
    assert client.post(path, json={"hash": draft["hash"]}, headers=AUTH).status_code == 200
    assert sends.calls == [("hoca@uni.example.edu", "Konu", "Metin")]
    assert client.post(path, json={"hash": draft["hash"]}, headers=AUTH).status_code == 409
    assert len(sends.calls) == 1
    assert client.get("/v1/drafts", headers=AUTH).json() == []


def test_changed_draft_is_not_sent(client, db, sends):
    draft_id = db.create_draft("hoca@uni.example.edu", "Konu", "Metin", NOW)
    approved = draft_hash("hoca@uni.example.edu", "Konu", "Metin")
    db.db.execute("UPDATE drafts SET recipient = 'saldirgan@kotu.example' WHERE id = ?", (draft_id,))
    db.db.commit()
    assert client.post(f"/v1/drafts/{draft_id}/send", json={"hash": approved}, headers=AUTH).status_code == 409
    assert sends.calls == []


@pytest.mark.parametrize(
    ("subject", "body"),
    [("Mazeret - [Adın Soyadın]", "Merhaba"), ("Mazeret", "Saygılarımla,\n[Öğrenci No]")],
)
def test_draft_with_an_unfilled_field_is_not_sent(client, db, sends, subject, body):
    draft_id = db.create_draft("hoca@uni.example.edu", subject, body, NOW)
    approved = draft_hash("hoca@uni.example.edu", subject, body)
    assert client.post(f"/v1/drafts/{draft_id}/send", json={"hash": approved}, headers=AUTH).status_code == 422
    assert sends.calls == []
    assert len(db.pending_drafts()) == 1


def test_failed_send_keeps_the_draft(api_settings, db):
    client = TestClient(create_app(api_settings, Llm(), Sends(fail=True)))
    draft_id = db.create_draft("a@b.c", "K", "M", NOW)
    response = client.post(f"/v1/drafts/{draft_id}/send", json={"hash": draft_hash("a@b.c", "K", "M")}, headers=AUTH)
    assert response.status_code == 502
    assert len(client.get("/v1/drafts", headers=AUTH).json()) == 1


def test_discarded_draft_cannot_be_sent(client, db, sends):
    draft_id = db.create_draft("a@b.c", "K", "M", NOW)
    assert client.post(f"/v1/drafts/{draft_id}/discard", headers=AUTH).status_code == 200
    sent = client.post(f"/v1/drafts/{draft_id}/send", json={"hash": draft_hash("a@b.c", "K", "M")}, headers=AUTH)
    assert sent.status_code == 409 and sends.calls == []


def test_unknown_draft_is_404(client):
    assert client.post("/v1/drafts/yok/send", json={"hash": "x"}, headers=AUTH).status_code == 404


def test_events_are_newest_first(client, db):
    db.add_event("k", "new", "high", "Eski", "", "", NOW)
    db.add_event("k", "new", "high", "Yeni", "", "", NOW)
    assert [e["title"] for e in client.get("/v1/events", headers=AUTH).json()] == ["Yeni", "Eski"]


def test_deleted_event_is_gone_and_its_id_is_not_reused(client, db):
    db.add_event("k", "new", "high", "Sil", "", "", NOW)
    event_id = client.get("/v1/events", headers=AUTH).json()[0]["id"]
    assert client.delete(f"/v1/events/{event_id}", headers=AUTH).status_code == 200
    assert client.get("/v1/events", headers=AUTH).json() == []
    db.add_event("k", "new", "high", "Sonraki", "", "", NOW)
    assert client.get("/v1/events", headers=AUTH).json()[0]["id"] > event_id


def test_event_carries_its_item_as_it_is_now(client, db):
    db.upsert(Item(key="assignment:1", kind="assignment", title="HW1", course="COMP303", url="u", due_at=NOW), NOW)
    db.add_event("assignment:1", "reminder", "high", "24 saat kaldı: COMP303: HW1", "", "u", NOW)
    db.add_event("system:Canvas", "alert", "critical", "Canvas takibi çalışmıyor", "", "", NOW)
    alert, reminder = client.get("/v1/events", headers=AUTH).json()
    assert alert["current"] is None
    assert reminder["current"]["dueAt"] and reminder["current"]["submitted"] is False


def test_refresh_asks_the_watcher_and_returns_when_a_round_finished(client, db, api_settings, monkeypatch):
    monkeypatch.setattr("ai_ders.api.POLL_WAIT_SECONDS", 0.2)
    monkeypatch.setattr("ai_ders.api.POLL_CHECK_SECONDS", 0.01)
    request = api_settings.state_dir / "poll-request"
    assert client.post("/v1/events/refresh", headers=AUTH).json() == {"refreshed": False}  # no watcher answered
    assert request.exists()

    db.set_meta("last_poll_at", datetime.now(UTC).isoformat())
    request.unlink()
    assert client.post("/v1/events/refresh", headers=AUTH).json() == {"refreshed": True}
    assert not request.exists()  # a round just ran: Canvas is left alone


def test_event_says_what_it_is_about(client, db):
    db.add_event("mail:5:101", "new", "high", "Vize", "", "", NOW)
    assert client.get("/v1/events", headers=AUTH).json()[0]["itemKey"] == "mail:5:101"


def gated(api_settings, sends):
    # Port 9 (discard) has nothing listening: a gate that is down.
    return TestClient(create_app(replace(api_settings, gpu_gate_url="http://127.0.0.1:9"), Llm(), sends))


def test_gpu_mode_is_validated(api_settings, sends):
    assert gated(api_settings, sends).post("/v1/gpu", json={"mode": "turbo"}, headers=AUTH).status_code == 400


def test_today_survives_a_stopped_gate(api_settings, sends):
    body = gated(api_settings, sends).get("/v1/today", headers=AUTH).json()
    assert body["upcoming"] == [] and body["pendingDrafts"] == 0
    assert body["gpu"]["llmActive"] is False


def test_new_events_start_unread_and_go_read(client, db):
    now = datetime.now(UTC)
    db.add_event("mail:5:101", "new", "high", "Mail", "b", "", now)
    db.add_event("assignment:1", "new", "high", "Odev", "b", "", now)
    events = {e["itemKey"]: e for e in client.get("/v1/events", headers=AUTH).json()}
    assert events["mail:5:101"]["read"] is False and events["mail:5:101"]["source"] == "mail"
    assert events["assignment:1"]["read"] is False and events["assignment:1"]["source"] == "canvas"
    assert client.post(f"/v1/events/{events['mail:5:101']['id']}/read", json={"read": True}, headers=AUTH).status_code == 200
    events = {e["itemKey"]: e for e in client.get("/v1/events", headers=AUTH).json()}
    assert events["mail:5:101"]["read"] is True and events["assignment:1"]["read"] is False
    client.post(f"/v1/events/{events['mail:5:101']['id']}/read", json={"read": False}, headers=AUTH)
    assert {e["itemKey"]: e for e in client.get("/v1/events", headers=AUTH).json()}["mail:5:101"]["read"] is False


def test_read_all_touches_only_its_own_list(client, db):
    now = datetime.now(UTC)
    db.add_event("mail:5:101", "new", "high", "Mail", "b", "", now)
    db.add_event("system:Mail", "alert", "critical", "Mail sorunu", "b", "", now)
    db.add_event("assignment:1", "new", "high", "Odev", "b", "", now)
    db.add_event("system:Canvas", "alert", "critical", "Canvas sorunu", "b", "", now)
    assert client.post("/v1/events/read-all", json={"source": "mail"}, headers=AUTH).status_code == 200
    events = {e["itemKey"]: e for e in client.get("/v1/events", headers=AUTH).json()}
    assert events["mail:5:101"]["read"] and events["system:Mail"]["read"]
    assert not events["assignment:1"]["read"] and not events["system:Canvas"]["read"]
    assert client.post("/v1/events/read-all", json={"source": "other"}, headers=AUTH).status_code == 400


def test_old_notifications_count_as_read_after_the_upgrade(tmp_path):
    import sqlite3

    path = tmp_path / "old.sqlite3"
    Store(path).close()
    raw = sqlite3.connect(path)
    raw.execute("ALTER TABLE events RENAME TO events_new")
    raw.execute("CREATE TABLE events AS SELECT id, item_key, type, level, title, body, url, created_at, sent_at FROM events_new")
    raw.execute("DROP TABLE events_new")
    raw.execute("INSERT INTO events (id, item_key, type, level, title, body, url, created_at) VALUES (1, 'a', 'new', 'high', 't', 'b', '', '2026-01-01T00:00:00+00:00')")
    raw.commit()
    raw.close()
    store = Store(path)
    assert store.recent_events(5)[0]["read_at"] is not None
    store.add_event("b", "new", "high", "t", "b", "", datetime.now(UTC))
    assert store.recent_events(5)[0]["read_at"] is None
    store.close()


def test_gpu_counts_what_was_done_today(api_settings, sends, db):
    now = datetime.now(UTC)
    old = now - timedelta(days=2)
    conversation = db.new_conversation("soru", now)
    db.add_chat("user", "soru", now, conversation)
    db.add_chat("assistant", "cevap", now, conversation)
    db.add_chat("assistant", "eski cevap", old, conversation)
    db.add_event("a:1", "new", "high", "t", "b", "", now)
    db.add_event("a:2", "new", "high", "t", "b", "", old)
    body = gated(api_settings, sends).get("/v1/gpu", headers=AUTH).json()
    assert body["today"] == {"answers": 1, "notifications": 1}


def test_without_a_gate_there_is_no_gpu_switch(client):
    assert client.get("/v1/gpu", headers=AUTH).status_code == 404
    assert client.post("/v1/gpu", json={"mode": "compute"}, headers=AUTH).status_code == 404
    assert client.get("/v1/today", headers=AUTH).json()["gpu"]["llmActive"] is True


class Gemini:
    model = "gemini-3.8-flash"

    def __init__(self):
        self.tools = []

    def chat(self, messages, tools):
        self.tools.append({t["function"]["name"] for t in tools})
        return {"content": "Bulut cevabı"}


def lister(key):
    if key != "AIza-dogru-anahtar":
        raise LlmBusy("Gemini bu anahtarı kabul etmedi")
    return ["gemini-3.8-flash", "gemini-3.5-flash"]


def gemini_only(api_settings, sends, gemini=None):
    return TestClient(create_app(api_settings, None, sends, gemini=gemini, gemini_lister=lister))


def test_a_server_without_a_local_model_answers_with_gemini(api_settings, sends):
    model = Gemini()
    client = gemini_only(api_settings, sends, model)
    setup = client.get("/v1/chat/setup", headers=AUTH).json()
    assert [(m["id"], m["name"]) for m in setup["models"]] == [("gemini", "Kamil")]
    assert setup["features"] == {"localModel": False, "gpuGate": False, "tasks": False}
    assert setup["schoolDomain"] == "uni.example.edu"
    # An older app asks for the local model; the only model there is answers.
    reply = client.post("/v1/chat", json={"text": "Merhaba", "model": "local"}, headers=AUTH).json()
    assert reply["reply"] == "Bulut cevabı"
    assert "read_mail" not in model.tools[0]  # mail stays home unless the student allows it


def test_without_any_model_chat_says_what_to_do(api_settings, sends):
    client = gemini_only(api_settings, sends)
    response = client.post("/v1/chat", json={"text": "Merhaba"}, headers=AUTH)
    assert response.status_code == 409 and "Ayarlar" in response.json()["detail"]
    assert client.get("/v1/today", headers=AUTH).json()["gpu"]["llmActive"] is False


def test_a_gemini_key_from_the_app_is_checked_kept_private_and_used(api_settings, sends):
    client = gemini_only(api_settings, sends)
    bad = client.put("/v1/settings/gemini", json={"key": "AIza-yanlis-anahtar"}, headers=AUTH)
    assert bad.status_code == 400 and not (api_settings.state_dir / "gemini.json").exists()
    good = client.put("/v1/settings/gemini", json={"key": "AIza-dogru-anahtar"}, headers=AUTH).json()
    assert good == {"connected": True, "source": "app", "model": "gemini-3.8-flash", "mailAllowed": False}
    stored = api_settings.state_dir / "gemini.json"
    assert stored.stat().st_mode & 0o777 == 0o600
    assert "AIza" not in client.get("/v1/settings/gemini", headers=AUTH).text  # the key never comes back
    assert client.get("/v1/settings/gemini/models", headers=AUTH).json() == ["gemini-3.8-flash", "gemini-3.5-flash"]
    allowed = client.put("/v1/settings/gemini", json={"mailAllowed": True, "model": "gemini-3.5-flash"}, headers=AUTH).json()
    assert allowed["mailAllowed"] is True and allowed["model"] == "gemini-3.5-flash"
    assert "Mail açık" in client.get("/v1/chat/setup", headers=AUTH).json()["models"][0]["detail"]
    assert client.delete("/v1/settings/gemini", headers=AUTH).json()["connected"] is False


def test_mail_reaches_gemini_only_when_the_student_allows_it(api_settings, sends):
    model = Gemini()
    client = gemini_only(api_settings, sends, model)
    client.put("/v1/settings/gemini", json={"mailAllowed": True}, headers=AUTH)
    client.post("/v1/chat", json={"text": "Mail var mı?", "new": True}, headers=AUTH)
    assert "read_mail" in model.tools[0]


def test_a_key_set_on_the_server_cannot_be_replaced_from_the_app(api_settings, sends):
    client = TestClient(create_app(replace(api_settings, gemini_key="sunucu"), None, sends, gemini_lister=lister))
    assert client.get("/v1/settings/gemini", headers=AUTH).json()["source"] == "server"
    assert client.put("/v1/settings/gemini", json={"key": "AIza-dogru-anahtar"}, headers=AUTH).status_code == 409


def test_no_published_app_is_a_404(client):
    assert client.get("/v1/app/latest", headers=AUTH).status_code == 404
    assert client.get("/v1/app/apk", headers=AUTH).status_code == 404


def test_published_app_is_offered_with_its_checksum(client, api_settings):
    releases = api_settings.state_dir / "app"
    releases.mkdir()
    (releases / "ai-ders.apk").write_bytes(b"PK-apk")
    (releases / "latest.json").write_text('{"versionCode": 29400000, "sha256": "ab", "size": 6}')
    assert client.get("/v1/app/latest", headers=AUTH).json()["versionCode"] == 29400000
    apk = client.get("/v1/app/apk", headers=AUTH)
    assert apk.content == b"PK-apk"
    assert apk.headers["content-type"] == "application/vnd.android.package-archive"


def test_item_detail_returns_the_whole_mail(client, db):
    db.upsert(Item(key="mail:5:101", kind="mail", title="Vize", sender="Hoca <h@uni.example.edu>", body="Uzun metin"), NOW)
    detail = client.get("/v1/items/mail:5:101", headers=AUTH).json()
    assert (detail["title"], detail["sender"], detail["body"]) == ("Vize", "Hoca <h@uni.example.edu>", "Uzun metin")


def test_mail_images_are_served_only_by_their_hash(client, db, api_settings):
    from ai_ders.models import Attachment

    image = "c" * 64
    api_settings.image_dir.mkdir()
    (api_settings.image_dir / f"{image}.jpg").write_bytes(b"\xff\xd8\xffclean")
    files = (Attachment("afis.png", "image/png", 2_000_000, image, 800, 600), Attachment("form.pdf", "application/pdf", 9))
    db.upsert(Item(key="mail:5:102", kind="mail", title="Afiş", attachments=files), NOW)
    detail = client.get("/v1/items/mail:5:102", headers=AUTH).json()
    assert [(a["name"], a["image"]) for a in detail["attachments"]] == [("afis.png", image), ("form.pdf", None)]
    served = client.get(f"/v1/images/{image}", headers=AUTH)
    assert served.content == b"\xff\xd8\xffclean" and served.headers["content-type"] == "image/jpeg"
    (api_settings.state_dir / "ai-ders.jpg").write_bytes(b"x")
    for bad in ("ai-ders", "..%2Fai-ders", "C" * 64, "d" * 64):
        assert client.get(f"/v1/images/{bad}", headers=AUTH).status_code == 404


def test_unknown_item_is_a_404(client):
    assert client.get("/v1/items/mail:5:999", headers=AUTH).status_code == 404


class FakeTasks:
    def __init__(self):
        self.added = []
        self.removed = []
        self.fail_remove = False

    def add(self, title, notes, due):
        self.added.append((title, notes, due))
        return f"task-{len(self.added)}"

    def remove(self, task_id):
        if self.fail_remove:
            raise httpx.ConnectError("down")
        self.removed.append(task_id)


def test_google_tasks_not_connected_is_a_clear_409(client, db):
    db.upsert(Item(key="assignment:1", kind="assignment", title="HW1", course="COMP303"), NOW)
    response = client.post("/v1/tasks", json={"key": "assignment:1"}, headers=AUTH)
    assert response.status_code == 409 and "bağlı değil" in response.json()["detail"]
    assert client.get("/v1/today", headers=AUTH).json()["tasksEnabled"] is False


def test_item_goes_to_google_tasks_once_with_its_local_due_date(api_settings, sends, db):
    from datetime import date, timedelta as td

    tasks = FakeTasks()
    client = TestClient(create_app(api_settings, Llm(), sends, tasks))
    # Counted from today, so that it stays in the coming days whenever this runs.
    due = datetime.now(UTC).replace(hour=20, minute=59, second=0, microsecond=0) + td(days=2)  # 23:59 in Istanbul
    db.upsert(Item(key="assignment:1", kind="assignment", title="HW1", course="COMP303", url="https://c/a/1", due_at=due), NOW)
    assert client.post("/v1/tasks", json={"key": "assignment:1"}, headers=AUTH).json() == {"status": "added"}
    assert client.post("/v1/tasks", json={"key": "assignment:1"}, headers=AUTH).json() == {"status": "exists"}
    assert tasks.added == [("COMP303: HW1", "https://c/a/1", due.astimezone(api_settings.timezone).date())]
    today = client.get("/v1/today", headers=AUTH).json()
    assert today["tasksEnabled"] is True
    assert [u["inTasks"] for u in today["upcoming"]] == [True]
    assert client.post("/v1/tasks", json={"key": "assignment:404"}, headers=AUTH).status_code == 404


class FakeGemini:
    model = "gemini-test-flash"

    def __init__(self):
        self.tools_seen = []

    def chat(self, messages, tools):
        self.tools_seen.append({s["function"]["name"] for s in tools})
        return {"content": "Gemini cevabı"}


def test_gemini_must_be_connected_to_be_picked(client):
    assert client.post("/v1/chat", json={"text": "Selam", "model": "gemini"}, headers=AUTH).status_code == 409
    assert [m["id"] for m in client.get("/v1/chat/setup", headers=AUTH).json()["models"]] == ["local"]


def test_gemini_answers_without_the_mail_tools(api_settings, sends):
    gemini = FakeGemini()
    client = TestClient(create_app(api_settings, Llm(), sends, gemini=gemini))
    reply = client.post("/v1/chat", json={"text": "Ödev 2 ne?", "model": "gemini", "new": True}, headers=AUTH).json()
    assert reply["reply"] == "Gemini cevabı"
    assert "search_mail" not in gemini.tools_seen[0] and "read_mail" not in gemini.tools_seen[0]
    assert "list_upcoming" in gemini.tools_seen[0]
    setup = client.get("/v1/chat/setup", headers=AUTH).json()
    assert [m["id"] for m in setup["models"]] == ["local", "gemini"]


def test_setup_greets_by_first_name(api_settings, sends):
    client = TestClient(create_app(replace(api_settings, student_name="AYŞE NUR YILMAZ"), Llm(), sends))
    assert client.get("/v1/chat/setup", headers=AUTH).json()["firstName"] == "Ayşe"


def test_task_can_be_taken_back_out_and_added_again(api_settings, sends, db):
    db.upsert(Item(key="assignment:1", kind="assignment", title="HW1", course="COMP303", url="u"), NOW)
    tasks = FakeTasks()
    client = TestClient(create_app(api_settings, Llm(), sends, tasks))
    client.post("/v1/tasks", json={"key": "assignment:1"}, headers=AUTH)

    assert client.post("/v1/tasks/remove", json={"key": "assignment:1"}, headers=AUTH).json() == {"status": "removed"}
    assert len(tasks.removed) == 1
    assert client.post("/v1/tasks/remove", json={"key": "assignment:1"}, headers=AUTH).json() == {"status": "absent"}
    assert len(tasks.removed) == 1  # nothing of ours left to remove
    assert client.post("/v1/tasks", json={"key": "assignment:1"}, headers=AUTH).json() == {"status": "added"}


def test_failed_removal_keeps_the_record(api_settings, sends, db):
    db.upsert(Item(key="assignment:1", kind="assignment", title="HW1", course="COMP303", url="u"), NOW)
    tasks = FakeTasks()
    tasks.fail_remove = True
    client = TestClient(create_app(api_settings, Llm(), sends, tasks))
    client.post("/v1/tasks", json={"key": "assignment:1"}, headers=AUTH)
    assert client.post("/v1/tasks/remove", json={"key": "assignment:1"}, headers=AUTH).status_code == 502
    assert db.get_meta("gtask:assignment:1")


def test_chat_progress_tells_the_steps_of_that_question(client):
    turn = "turn-12345"
    assert client.get(f"/v1/chat/progress/{turn}", headers=AUTH).json() == {"steps": []}
    client.post("/v1/chat", json={"text": "Selam", "turnId": turn}, headers=AUTH)
    assert client.get(f"/v1/chat/progress/{turn}", headers=AUTH).json() == {"steps": ["Soruyu düşünüyor"]}
    assert client.get("/v1/chat/progress/baska-soru", headers=AUTH).json() == {"steps": []}


def test_bad_turn_id_is_refused(client):
    assert client.post("/v1/chat", json={"text": "Selam", "turnId": "../x"}, headers=AUTH).status_code == 422


def test_kamil_priority_needs_a_gate_and_reports_a_gate_that_is_down(client, api_settings, sends):
    assert client.post("/v1/gpu/priority", json={"on": True}, headers=AUTH).status_code == 404
    assert gated(api_settings, sends).post("/v1/gpu/priority", json={"on": True}, headers=AUTH).status_code == 503
