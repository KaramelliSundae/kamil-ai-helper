"""Replying to mail on a server: the same features, and the same rules, as the phone mode."""

from __future__ import annotations

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from ai_ders.api import create_app
from ai_ders.llm import LlmBusy
from ai_ders.models import Attachment, Item
from ai_ders.store import Store, draft_hash

from .conftest import NOW
from .test_api import AUTH, Sends

MAIL = Item(
    key="mail:5:101", kind="mail", title="Vize tarihi", sender="Hoca <hoca@uni.example.edu>", body="Vize 12 Kasım'da.",
    posted_at=NOW, thread="<a@uni.example.edu>", reply_to="hoca@uni.example.edu", message_id="<b@uni.example.edu>",
    references="<a@uni.example.edu>",
)


class Writer:
    """A model that records what it was given."""

    def __init__(self, text="Merhaba hocam,\nTeşekkürler.\n[Adın]", busy=False):
        self.text = text
        self.busy = busy
        self.calls = []

    def chat(self, messages, tools):
        if self.busy:
            raise LlmBusy("GPU başka bir işte")
        self.calls.append((messages, tools))
        return {"content": f"<think>düşünce</think>{self.text}"}


@pytest.fixture
def api_settings(settings):
    return replace(settings, api_token="dogru", school_domain="uni.example.edu", smtp_host="smtp.uni.example.edu")


@pytest.fixture
def db(api_settings):
    store = Store(api_settings.db_path)
    store.upsert(MAIL, NOW)
    yield store
    store.close()


def make(api_settings, llm=None, sends=None, gemini=None):
    return TestClient(create_app(api_settings, llm, sends or Sends(), gemini=gemini, gemini_lister=lambda key: []))


def test_events_and_items_carry_what_the_app_groups_conversations_by(api_settings, db):
    db.add_event(MAIL.key, "new", "high", "Mail: Vize tarihi", "", "", NOW)
    db.upsert(replace(MAIL, key="mail:5:102", reply_to="x@disari.example", attachments=(Attachment("a.pdf", "application/pdf", 9),)), NOW)
    db.add_event("mail:5:102", "new", "high", "Mail: Dışarıdan", "", "", NOW)
    client = make(api_settings, Writer())
    outside, school = client.get("/v1/events", headers=AUTH).json()
    assert school["thread"] == "<a@uni.example.edu>" and school["fromSchool"] is True and school["hasFiles"] is False
    assert outside["fromSchool"] is False and outside["hasFiles"] is True and outside["outgoing"] is False
    assert client.get(f"/v1/items/{MAIL.key}", headers=AUTH).json()["replyTo"] == "hoca@uni.example.edu"


def test_the_local_model_writes_the_reply_from_the_whole_conversation(api_settings, db):
    db.upsert(replace(MAIL, key="mail:out:5:1", sender="Sen", title="Re: Vize tarihi", body="Hangi salon?"), NOW)
    writer = Writer()
    client = make(api_settings, writer)
    reply = client.post("/v1/mail/reply-text", json={"key": MAIL.key}, headers=AUTH)
    assert reply.json() == {"body": "Merhaba hocam,\nTeşekkürler.\n[Adın]"}
    (messages, tools), = writer.calls
    assert tools == [] and "Hangi salon?" in messages[1]["content"] and "Vize 12 Kasım'da." in messages[1]["content"]
    assert messages[1]["content"].startswith("<guvenilmeyen_icerik")
    assert db.pending_drafts() == []  # it only fills the box


def test_mail_reaches_a_cloud_model_only_when_the_student_allows_it(api_settings, db):
    cloud = Writer("Bulut")
    client = make(api_settings, None, gemini=cloud)
    refused = client.post("/v1/mail/reply-text", json={"key": MAIL.key}, headers=AUTH)
    assert refused.status_code == 409 and "bulut modele kapalı" in refused.json()["detail"] and cloud.calls == []
    client.put("/v1/settings/gemini", json={"mailAllowed": True}, headers=AUTH)
    assert client.post("/v1/mail/reply-text", json={"key": MAIL.key}, headers=AUTH).json() == {"body": "Bulut"}


def test_a_busy_gpu_falls_back_to_the_cloud_only_when_allowed(api_settings, db):
    cloud = Writer("Bulut")
    client = make(api_settings, Writer(busy=True), gemini=cloud)
    assert client.post("/v1/mail/reply-text", json={"key": MAIL.key}, headers=AUTH).status_code == 503
    client.put("/v1/settings/gemini", json={"mailAllowed": True}, headers=AUTH)
    assert client.post("/v1/mail/reply-text", json={"key": MAIL.key}, headers=AUTH).json() == {"body": "Bulut"}


def test_no_model_says_so(api_settings, db):
    response = make(api_settings, None).post("/v1/mail/reply-text", json={"key": MAIL.key}, headers=AUTH)
    assert response.status_code == 409 and "kendin yazabilirsin" in response.json()["detail"]


def test_only_a_mail_can_be_replied_to(api_settings, db):
    db.upsert(Item(key="canvas:1", kind="assignment", title="Ödev"), NOW)
    client = make(api_settings, Writer())
    for key in ("canvas:1", "yok"):
        assert client.post("/v1/mail/reply-text", json={"key": key}, headers=AUTH).status_code == 404
        assert client.post("/v1/mail/reply", json={"key": key, "to": "a@b.example", "body": "x"}, headers=AUTH).status_code == 404


def test_a_saved_reply_waits_in_onaylar_with_the_conversation_headers(api_settings, db):
    client = make(api_settings, Writer())
    draft = client.post("/v1/mail/reply", json={"key": MAIL.key, "to": " hoca@uni.example.edu ", "body": "Tamam [Adın]"}, headers=AUTH).json()
    assert (draft["to"], draft["subject"]) == ("hoca@uni.example.edu", "Re: Vize tarihi")
    assert draft["warnings"] == ["Köşeli parantezli yerleri doldurmadan gönderme."]
    stored = db.get_draft(draft["id"])
    assert (stored["thread"], stored["in_reply_to"], stored["refs"]) == ("<a@uni.example.edu>", "<b@uni.example.edu>", "<a@uni.example.edu>")
    assert client.get("/v1/drafts", headers=AUTH).json() == [draft]


def test_sending_a_reply_names_the_conversation_and_shows_in_it(api_settings, db):
    sends = Sends(sent_copy=False)
    client = make(api_settings, Writer(), sends)
    sent = client.post("/v1/mail/reply/send", json={"key": MAIL.key, "to": "hoca@uni.example.edu", "body": "Teşekkürler"}, headers=AUTH)
    assert sent.json() == {"status": "sent", "sentCopy": False}
    mail, = sends.mails
    assert (mail.to, mail.subject, mail.in_reply_to) == (("hoca@uni.example.edu",), "Re: Vize tarihi", "<b@uni.example.edu>")
    assert mail.references == "<a@uni.example.edu> <b@uni.example.edu>"
    own = next(e for e in client.get("/v1/events", headers=AUTH).json() if e["itemKey"].startswith("mail:sent:"))
    assert own["outgoing"] is True and own["read"] is True and own["thread"] == "<a@uni.example.edu>"
    assert (own["title"], own["body"]) == ("Mail: Re: Vize tarihi", "Kime: hoca@uni.example.edu")
    assert db.has_message_id("<id1@uni.example.edu>")  # so the Sent folder's copy won't show twice
    assert db.unsent_events(("normal",)) == []  # never notified, never in a digest
    assert db.pending_drafts() == []


def test_a_reply_that_fails_to_send_leaves_nothing_behind(api_settings, db):
    client = make(api_settings, Writer(), Sends(fail=True))
    failed = client.post("/v1/mail/reply/send", json={"key": MAIL.key, "to": "hoca@uni.example.edu", "body": "x"}, headers=AUTH)
    assert failed.status_code == 502 and "kabul etmedi" in failed.json()["detail"]
    assert db.pending_drafts() == []
    assert not any(e["itemKey"].startswith("mail:sent:") for e in client.get("/v1/events", headers=AUTH).json())


def test_editing_a_draft_needs_the_version_the_student_saw(api_settings, db):
    client = make(api_settings, Writer())
    draft_id = db.create_draft("hoca@uni.example.edu", "Konu", "Metin", NOW)
    seen = draft_hash("hoca@uni.example.edu", "Konu", "Metin")
    change = {"to": "hoca@uni.example.edu", "subject": "Yeni\r\nBcc: x@y.z", "body": "Yeni metin"}
    assert client.put(f"/v1/drafts/{draft_id}", json={**change, "hash": "eski"}, headers=AUTH).status_code == 409
    edited = client.put(f"/v1/drafts/{draft_id}", json={**change, "hash": seen}, headers=AUTH).json()
    assert (edited["subject"], edited["body"]) == ("Yeni Bcc: x@y.z", "Yeni metin")  # a subject stays one line
    assert client.put(f"/v1/drafts/{draft_id}", json={**change, "hash": seen}, headers=AUTH).status_code == 409
    db.set_draft_status(draft_id, "sent")
    assert client.put(f"/v1/drafts/{draft_id}", json={**change, "hash": edited["hash"]}, headers=AUTH).status_code == 409


def test_a_draft_opened_in_the_mail_app_leaves_onaylar(api_settings, db):
    client = make(api_settings, Writer())
    draft_id = db.create_draft("hoca@uni.example.edu", "Konu", "Metin", NOW)
    seen = draft_hash("hoca@uni.example.edu", "Konu", "Metin")
    assert client.post(f"/v1/drafts/{draft_id}/opened", json={"hash": "eski"}, headers=AUTH).status_code == 409
    assert client.post(f"/v1/drafts/{draft_id}/opened", json={"hash": seen}, headers=AUTH).json() == {"status": "opened"}
    assert db.pending_drafts() == []


def test_can_send_is_whether_the_sending_sandbox_runs(api_settings, db):
    assert make(api_settings, sends=Sends()).get("/v1/mail/can-send", headers=AUTH).json() == {"canSend": True}
    assert make(api_settings, sends=Sends(running=False)).get("/v1/mail/can-send", headers=AUTH).json() == {"canSend": False}
    unset = replace(api_settings, smtp_host="")
    assert make(unset, sends=Sends()).get("/v1/mail/can-send", headers=AUTH).json() == {"canSend": False}
