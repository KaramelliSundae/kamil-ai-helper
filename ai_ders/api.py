"""The phone's API. Listens on one private address (API_HOST, for example a Tailscale IP), and every route
needs the device token.

No `from __future__ import annotations` here: FastAPI has to see the route annotations as real types,
and `Db` is local to create_app().
"""

import hmac
import json
import os
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .agent import answer
from .config import Settings
from .gtasks import GoogleCredentials, GoogleTasks, GoogleTasksError
from .llm import GeminiClient, LlmBusy, LlmClient, gemini_models
from .notify import send_approved_draft
from .store import Store, draft_hash, to_time
from .tools import MAIL_TOOLS, Tools

UPCOMING_DAYS = 14
CONVERSATION_LIMIT = 100
MESSAGE_LIMIT = 200
PLACEHOLDER = re.compile(r"\[[^\]\n]{2,60}\]")  # for example [Adın Soyadın]
GPU_MODES = ("auto", "image")
GEMINI_FILE = "gemini.json"  # a key entered in the app, with the model and the mail choice
APK_TYPE = "application/vnd.android.package-archive"
IMAGE_ID = re.compile(r"[0-9a-f]{64}")


class ChatRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    conversationId: int | None = None
    # A new chat in the app. Without it and without an id, the latest conversation goes on (older app versions).
    new: bool = False
    model: Literal["local", "gemini"] = "local"
    # Chosen by the app, so it can ask how this question is going while it waits.
    turnId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{8,64}$")


class TaskRequest(BaseModel):
    key: str


class SendRequest(BaseModel):
    hash: str


class ModeRequest(BaseModel):
    mode: str


class GeminiSettingsRequest(BaseModel):
    key: str | None = Field(default=None, min_length=10, max_length=200)
    model: str | None = Field(default=None, max_length=80, pattern=r"^[\w.-]+$")
    mailAllowed: bool | None = None


TURNS_KEPT = 8
POLL_WAIT_SECONDS = 20.0
POLL_CHECK_SECONDS = 0.5
POLL_COOLDOWN_SECONDS = 60  # pulling again and again must not hammer Canvas and the mail server


def event_json(row: Any, item: Any = None) -> dict[str, Any]:
    """An event is what happened then; `current` is its item now, so the app can say what still holds."""
    return {
        "id": row["id"], "itemKey": row["item_key"], "type": row["type"], "level": row["level"],
        "title": row["title"], "body": row["body"], "url": row["url"], "createdAt": row["created_at"],
        "current": {
            "title": item["title"], "course": item["course"], "dueAt": item["due_at"],
            "submitted": bool(item["submitted"]), "grade": item["grade"],
        } if item is not None else None,
    }


def draft_json(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"], "to": row["recipient"], "subject": row["subject"], "body": row["body"],
        "hash": draft_hash(row["recipient"], row["subject"], row["body"]), "createdAt": row["created_at"],
        "warnings": [line for line in (row["warnings"] or "").split("\n") if line],
    }


def create_app(
    settings: Settings | None = None,
    llm: Any = None,
    send: Any = None,
    tasks: Any = None,
    gemini: Any = None,
    gemini_lister: Any = None,
) -> FastAPI:
    """`llm` is the local model, or None for a Gemini-only server. `gemini` and `gemini_lister` are for tests."""
    settings = settings or Settings.from_env()
    if llm is None and settings.local_llm_url:
        llm = LlmClient(settings.local_llm_url, settings.gpu_gate_url)
    send = send or send_approved_draft
    if tasks is None and settings.google_tasks:
        tasks = GoogleTasks(GoogleCredentials.parse(settings.google_tasks))
    injected_gemini = gemini
    list_models = gemini_lister or gemini_models
    gemini_path = settings.state_dir / GEMINI_FILE
    gate = settings.gpu_gate_url.rstrip("/")
    app = FastAPI(title="ai-ders", docs_url=None, redoc_url=None, openapi_url=None)

    def gemini_config() -> dict[str, Any]:
        try:
            data = json.loads(gemini_path.read_text())
        except (FileNotFoundError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def save_gemini_config(data: dict[str, Any]) -> None:
        """Written 0600 in the state folder, next to the database it would give access to anyway."""
        settings.state_dir.mkdir(parents=True, exist_ok=True)
        partial = gemini_path.with_suffix(".part")
        handle = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(handle, "w") as file:
            json.dump(data, file)
        os.replace(partial, gemini_path)

    def gemini_key() -> tuple[str | None, str | None]:
        """The key and where it came from: a server credential wins over one typed into the app."""
        if settings.gemini_key:
            return settings.gemini_key, "server"
        key = gemini_config().get("key")
        return (key, "app") if isinstance(key, str) and key else (None, None)

    def gemini_model() -> str:
        model = gemini_config().get("model")
        return model if isinstance(model, str) and model else settings.gemini_model

    def current_gemini() -> Any:
        if injected_gemini is not None:
            return injected_gemini
        key, _ = gemini_key()
        return GeminiClient(key, gemini_model()) if key else None

    def mail_to_gemini() -> bool:
        return gemini_config().get("mailAllowed") is True

    def gpu_state() -> dict[str, Any]:
        if gate:
            try:
                return httpx.get(f"{gate}/state", timeout=5.0).json()
            except (httpx.HTTPError, ValueError):
                return {"mode": "unknown", "llmActive": False, "blocked": "GPU kapısına ulaşılamıyor"}
        ready = llm is not None or current_gemini() is not None
        return {"mode": "none", "llmActive": ready, "blocked": None if ready else "model yok, Ayarlar'dan Gemini anahtarı gir"}

    def authorize(authorization: Annotated[str | None, Header()] = None) -> None:
        expected = f"Bearer {settings.api_token}"
        if not settings.api_token or not hmac.compare_digest(authorization or "", expected):
            raise HTTPException(401, "unauthorized")

    def open_store() -> Iterator[Store]:
        store = Store(settings.db_path)
        try:
            yield store
        finally:
            store.close()

    guarded = [Depends(authorize)]
    turns: OrderedDict[str, list[str]] = OrderedDict()  # what each recent question is doing, in memory only
    turns_lock = threading.Lock()
    Db = Annotated[Store, Depends(open_store)]

    @app.get("/v1/today", dependencies=guarded)
    def today(store: Db) -> dict[str, Any]:
        now = datetime.now(UTC)
        rows = store.upcoming(now, now + timedelta(days=UPCOMING_DAYS))
        upcoming = [
            {
                "key": r["key"], "kind": r["kind"], "title": r["title"], "course": r["course"], "url": r["url"],
                "dueAt": r["due_at"], "inTasks": store.get_meta(f"gtask:{r['key']}") is not None,
            }
            for r in rows
        ]
        return {
            "upcoming": upcoming, "pendingDrafts": len(store.pending_drafts()), "gpu": gpu_state(),
            "tasksEnabled": tasks is not None,
        }

    @app.post("/v1/tasks", dependencies=guarded)
    def add_task(request: TaskRequest, store: Db) -> dict[str, str]:
        """Puts a Canvas item into the student's Google Tasks, once."""
        if tasks is None:
            raise HTTPException(409, "Google Tasks bağlı değil")
        row = store.get_item(request.key)
        if row is None:
            raise HTTPException(404, "kayıt bulunamadı")
        marker = f"gtask:{request.key}"
        if store.get_meta(marker):
            return {"status": "exists"}
        due = to_time(row["due_at"])
        title = f"{row['course']}: {row['title']}" if row["course"] else row["title"]
        try:
            task_id = tasks.add(title, row["url"], due.astimezone(settings.timezone).date() if due else None)
        except GoogleTasksError as error:
            raise HTTPException(502, str(error)) from error
        except httpx.HTTPError as error:
            raise HTTPException(502, "Google Tasks'a ulaşılamadı") from error
        store.set_meta(marker, task_id)
        return {"status": "added"}

    @app.post("/v1/tasks/remove", dependencies=guarded)
    def remove_task(request: TaskRequest, store: Db) -> dict[str, str]:
        """Takes out only a task Kamil itself added: the id comes from our record, never from the request."""
        if tasks is None:
            raise HTTPException(409, "Google Tasks bağlı değil")
        marker = f"gtask:{request.key}"
        task_id = store.get_meta(marker)
        if not task_id:
            return {"status": "absent"}
        try:
            tasks.remove(task_id)
        except GoogleTasksError as error:
            raise HTTPException(502, str(error)) from error
        except httpx.HTTPError as error:
            raise HTTPException(502, "Google Tasks'a ulaşılamadı") from error
        store.delete_meta(marker)
        return {"status": "removed"}

    @app.get("/v1/events", dependencies=guarded)
    def events(store: Db, limit: int = 60) -> list[dict[str, Any]]:
        return [event_json(row, store.get_item(row["item_key"])) for row in store.recent_events(min(limit, 200))]

    @app.post("/v1/events/refresh", dependencies=guarded)
    def refresh_events(store: Db) -> dict[str, bool]:
        """Asks for a watcher round now and waits for it. This service holds no Canvas token: it only writes a
        file that ai-ders-watcher.path watches, so the round runs in the watcher's own sandbox."""
        before = store.get_meta("last_poll_at")
        last = to_time(before)
        if last and datetime.now(UTC) - last < timedelta(seconds=POLL_COOLDOWN_SECONDS):
            return {"refreshed": True}
        (settings.state_dir / "poll-request").write_text(datetime.now(UTC).isoformat(), encoding="utf-8")
        deadline = time.monotonic() + POLL_WAIT_SECONDS
        while time.monotonic() < deadline:
            if store.get_meta("last_poll_at") != before:
                return {"refreshed": True}
            time.sleep(POLL_CHECK_SECONDS)
        return {"refreshed": False}

    @app.delete("/v1/events/{event_id}", dependencies=guarded)
    def delete_event(event_id: int, store: Db) -> dict[str, str]:
        store.delete_event(event_id)
        return {"status": "deleted"}

    @app.get("/v1/items/{key:path}", dependencies=guarded)
    def item(key: str, store: Db) -> dict[str, Any]:
        """The full record behind an event, such as a whole mail, for the phone's detail view."""
        row = store.get_item(key)
        if row is None:
            raise HTTPException(404, "kayıt bulunamadı")
        return {
            "key": row["key"], "kind": row["kind"], "title": row["title"], "course": row["course"],
            "sender": row["sender"], "body": row["body"], "url": row["url"],
            "postedAt": row["posted_at"], "dueAt": row["due_at"], "grade": row["grade"],
            "submitted": bool(row["submitted"]),
            # Images come only as the sandbox re-encoded them; other files are listed, never served.
            "attachments": [
                {"name": a.name, "type": a.type, "size": a.size, "image": a.image, "width": a.width, "height": a.height}
                for a in Store.attachments(row)
            ],
        }

    @app.get("/v1/images/{image_id}", dependencies=guarded)
    def image(image_id: str) -> FileResponse:
        if not IMAGE_ID.fullmatch(image_id):
            raise HTTPException(404, "görsel bulunamadı")
        path = settings.image_dir / f"{image_id}.jpg"
        if not path.is_file():
            raise HTTPException(404, "görsel bulunamadı")
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=604800"})

    def messages(store: Store, conversation_id: int) -> list[dict[str, Any]]:
        rows = store.chat_history(conversation_id, MESSAGE_LIMIT)
        return [{"id": r["id"], "role": r["role"], "content": r["content"]} for r in rows]

    @app.get("/v1/chat", dependencies=guarded)
    def chat_history(store: Db) -> list[dict[str, Any]]:
        """The latest conversation, for app versions from before conversations."""
        latest = store.latest_conversation()
        return messages(store, latest) if latest is not None else []

    def note_step(turn_id: str | None, step: str) -> None:
        if turn_id is None:
            return
        with turns_lock:
            steps = turns.setdefault(turn_id, [])
            if not steps or steps[-1] != step:
                steps.append(step)
            while len(turns) > TURNS_KEPT:  # only the latest matter; a finished turn needs no clean-up of its own
                turns.popitem(last=False)

    @app.get("/v1/chat/progress/{turn_id}", dependencies=guarded)
    def chat_progress(turn_id: str) -> dict[str, list[str]]:
        with turns_lock:
            return {"steps": list(turns.get(turn_id, []))}

    @app.post("/v1/chat", dependencies=guarded)
    def chat(request: ChatRequest, store: Db) -> dict[str, Any]:
        conversation_id = request.conversationId
        if conversation_id is not None and store.conversation(conversation_id) is None:
            raise HTTPException(404, "sohbet bulunamadı")
        if conversation_id is None and not request.new:
            conversation_id = store.latest_conversation()
        gemini = current_gemini()
        # Without a local model, Gemini is the only model, whatever an older app asks for.
        cloud = request.model == "gemini" or llm is None
        if cloud and gemini is None:
            raise HTTPException(409, "Gemini bağlı değil, Ayarlar'dan API anahtarını gir")
        tools = Tools(
            store, settings.timezone, datetime.now(UTC), settings.student_name,
            blocked=MAIL_TOOLS if cloud and not mail_to_gemini() else frozenset(),
            school_domain=settings.school_domain,
        )
        try:
            result = answer(
                store, gemini if cloud else llm, tools, request.text, conversation_id,
                on_step=lambda step: note_step(request.turnId, step),
            )
        except LlmBusy as busy:
            raise HTTPException(503, str(busy)) from busy
        return {"reply": result.reply, "conversationId": result.conversation_id}

    @app.get("/v1/chat/setup", dependencies=guarded)
    def chat_setup() -> dict[str, Any]:
        """What this server offers, so the app shows only what works here."""
        gemini = current_gemini()
        models = []
        if llm is not None:
            models.append({"id": "local", "name": "Kamil", "detail": "Yerel model. Veri bu sunucudan çıkmaz."})
        if gemini is not None:
            mail = "Mail açık" if mail_to_gemini() else "Mail kapalı"
            name = "Gemini" if llm is not None else "Kamil"
            models.append({"id": "gemini", "name": name, "detail": f"{gemini.model}. Bulutta. {mail}."})
        first = (settings.student_name or "").split()
        return {
            "firstName": first[0].capitalize() if first else None,
            "models": models,
            "schoolDomain": settings.school_domain,
            "webmailUrl": settings.webmail_url,
            "features": {"localModel": llm is not None, "gpuGate": bool(gate), "tasks": tasks is not None},
        }

    @app.get("/v1/settings/gemini", dependencies=guarded)
    def gemini_settings() -> dict[str, Any]:
        key, source = gemini_key()
        return {"connected": key is not None, "source": source, "model": gemini_model(), "mailAllowed": mail_to_gemini()}

    @app.put("/v1/settings/gemini", dependencies=guarded)
    def set_gemini_settings(request: GeminiSettingsRequest) -> dict[str, Any]:
        """A new key is checked with Google first, and kept only if Google accepts it."""
        config = gemini_config()
        if request.key is not None:
            if settings.gemini_key:
                raise HTTPException(409, "anahtar sunucuda ayarlı, uygulamadan değiştirilemez")
            key = request.key.strip()
            try:
                available = list_models(key)
            except LlmBusy as error:
                raise HTTPException(400, str(error)) from error
            config["key"] = key
            if request.model is None and available and gemini_model() not in available:
                config["model"] = settings.gemini_model if settings.gemini_model in available else available[0]
        if request.model is not None:
            config["model"] = request.model
        if request.mailAllowed is not None:
            config["mailAllowed"] = request.mailAllowed
        save_gemini_config(config)
        return gemini_settings()

    @app.delete("/v1/settings/gemini", dependencies=guarded)
    def delete_gemini_settings() -> dict[str, Any]:
        config = gemini_config()
        config.pop("key", None)
        save_gemini_config(config)
        return gemini_settings()

    @app.get("/v1/settings/gemini/models", dependencies=guarded)
    def gemini_model_list() -> list[str]:
        key, _ = gemini_key()
        if key is None:
            raise HTTPException(409, "Gemini bağlı değil")
        try:
            return list_models(key)
        except LlmBusy as error:
            raise HTTPException(502, str(error)) from error

    @app.get("/v1/conversations", dependencies=guarded)
    def conversations(store: Db) -> list[dict[str, Any]]:
        return [
            {"id": r["id"], "title": r["title"], "updatedAt": r["updated_at"]}
            for r in store.conversations(CONVERSATION_LIMIT)
        ]

    @app.get("/v1/conversations/{conversation_id}", dependencies=guarded)
    def conversation(conversation_id: int, store: Db) -> dict[str, Any]:
        row = store.conversation(conversation_id)
        if row is None:
            raise HTTPException(404, "sohbet bulunamadı")
        return {"id": row["id"], "title": row["title"], "messages": messages(store, conversation_id)}

    @app.delete("/v1/conversations/{conversation_id}", dependencies=guarded)
    def delete_conversation(conversation_id: int, store: Db) -> dict[str, str]:
        store.delete_conversation(conversation_id)
        return {"status": "deleted"}

    @app.delete("/v1/conversations", dependencies=guarded)
    def delete_all_conversations(store: Db) -> dict[str, str]:
        store.delete_all_conversations()
        return {"status": "deleted"}

    @app.get("/v1/drafts", dependencies=guarded)
    def drafts(store: Db) -> list[dict[str, Any]]:
        return [draft_json(row) for row in store.pending_drafts()]

    @app.post("/v1/drafts/{draft_id}/send", dependencies=guarded)
    def send_draft(draft_id: str, request: SendRequest, store: Db) -> dict[str, str]:
        row = store.get_draft(draft_id)
        if row is None:
            raise HTTPException(404, "taslak bulunamadı")
        recipient, subject, body = row["recipient"], row["subject"], row["body"]
        if not hmac.compare_digest(request.hash, draft_hash(recipient, subject, body)):
            raise HTTPException(409, "taslak onayladığın halinden farklı")
        if PLACEHOLDER.search(f"{subject}\n{body}"):
            raise HTTPException(422, "taslakta doldurulmamış bir alan var, sil ve yeniden iste")
        if not store.claim_draft(draft_id, "sending"):
            raise HTTPException(409, "taslak zaten işlendi")
        try:
            send(settings, recipient, subject, body)
        except Exception as error:  # noqa: BLE001 - the draft goes back so nothing is lost
            store.db.execute("UPDATE drafts SET status = 'pending' WHERE id = ?", (draft_id,))
            store.db.commit()
            raise HTTPException(502, "mail gönderilemedi") from error
        store.db.execute("UPDATE drafts SET status = 'sent' WHERE id = ?", (draft_id,))
        store.db.commit()
        return {"status": "sent"}

    @app.post("/v1/drafts/{draft_id}/discard", dependencies=guarded)
    def discard_draft(draft_id: str, store: Db) -> dict[str, str]:
        if not store.claim_draft(draft_id, "discarded"):
            raise HTTPException(409, "taslak zaten işlendi")
        return {"status": "discarded"}

    @app.get("/v1/gpu", dependencies=guarded)
    def gpu() -> dict[str, Any]:
        if not gate:
            raise HTTPException(404, "bu sunucuda GPU kapısı yok")
        return gpu_state()

    @app.post("/v1/gpu", dependencies=guarded)
    def set_gpu(request: ModeRequest) -> dict[str, Any]:
        if not gate:
            raise HTTPException(404, "bu sunucuda GPU kapısı yok")
        if request.mode not in GPU_MODES:
            raise HTTPException(400, "mode must be auto or image")
        try:
            httpx.post(f"{gate}/mode", json={"mode": request.mode}, timeout=25.0).raise_for_status()
        except httpx.HTTPError as error:
            raise HTTPException(503, "GPU kapısına ulaşılamıyor") from error
        return gpu_state()

    # The phone updates itself from here. mobile/publish.sh writes both files, the APK first.
    releases = settings.state_dir / "app"

    @app.get("/v1/app/latest", dependencies=guarded)
    def latest_app() -> dict[str, Any]:
        try:
            return json.loads((releases / "latest.json").read_text())
        except FileNotFoundError:
            raise HTTPException(404, "yayınlanmış sürüm yok") from None

    @app.get("/v1/app/apk", dependencies=guarded)
    def app_apk() -> FileResponse:
        path = releases / "ai-ders.apk"
        if not path.is_file():
            raise HTTPException(404, "yayınlanmış sürüm yok")
        return FileResponse(path, media_type=APK_TYPE, filename="ai-ders.apk")

    return app
