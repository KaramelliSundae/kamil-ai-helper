"""The phone's API. Listens on one private address (API_HOST, for example a Tailscale IP), and every route
needs the device token.

No `from __future__ import annotations` here: FastAPI has to see the route annotations as real types,
and `Db` is local to create_app().
"""

import hashlib
import hmac
import json
import os
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any, Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .agent import answer
from .config import Settings
from .gcalendar import GoogleCalendar, has_calendar
from .gtasks import GoogleCredentials, GoogleTasks, GoogleTasksError
from .llm import PROVIDER_NAMES, GeminiClient, LlmBusy, LlmClient, clean_base_url, cloud_models, gemini_models
from .suggest import clean_event, clean_title, suggest_events, suggest_tasks
from .exams import CHECK_DAY_CHOICES, DEFAULT_CHECK_DAYS, is_exam_title, quiz_number
from .mailbox import OUTGOING_PREFIX
from .mailsend import MailSender, MailSendError, OutgoingMail, recipients
from .mailthread import plain_subject, reply_references, reply_subject
from .models import NORMAL, Item
from .reply import write_reply
from .store import draft_hash, event_source, Store, to_time
from .tools import MAIL_TOOLS, Tools, is_school_address

UPCOMING_DAYS = 14
QUIZ_DAYS = 365  # every quiz still ahead this term: Sınavlar shows them all, not just the next two weeks
CONVERSATION_LIMIT = 100
MESSAGE_LIMIT = 200
# A blank the model left for the student, for example [Adın Soyadın]: the same rule and words as the phone.
BLANK = re.compile(r"\[[^\]\n]{1,80}\]")
BLANKS = "Köşeli parantezli yerleri doldurmadan gönderme."
SENT_PREFIX = "mail:sent:"  # a mail sent from the app, until the Sent folder shows it too
REPLY_THREAD = 20  # the newest mails of a conversation a reply is written from; the writer reads the last few
GPU_MODES = ("assistant", "compute", "auto", "image")  # the last two: what apps not yet updated still send
TASK_DUE = "gtask_due:"  # the day a task was added for, to notice when its item or exam moves
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


class TaskKey(BaseModel):
    key: str


class TaskRequest(TaskKey):
    # The student's own choice of wording and day, for a mail or an announcement. Without them: the item's own.
    title: str | None = Field(default=None, max_length=300)
    due: date | None = None


class CalendarRequest(TaskKey):
    # What the student picked from the model's proposals. It is cleaned again here: the app is not trusted with a link.
    title: str = Field(max_length=300)
    start: str = Field(max_length=32)
    end: str | None = Field(default=None, max_length=32)
    location: str | None = Field(default=None, max_length=300)


class SendRequest(BaseModel):
    hash: str


class DraftChange(SendRequest):
    """The student's own edit. `hash` is the draft as they last saw it, so a change elsewhere is not overwritten."""
    to: str = Field(max_length=300)
    subject: str = Field(max_length=300)
    body: str = Field(max_length=20000)


class ReplyKey(BaseModel):
    key: str


class ReplyRequest(ReplyKey):
    to: str = Field(min_length=3, max_length=300)
    body: str = Field(min_length=1, max_length=20000)


class ModeRequest(BaseModel):
    mode: str
    # The app asks the student before sending this. True by default so an app not yet updated can still leave Compute.
    confirm: bool = True


class SyllabusCheckRequest(BaseModel):
    days: int


class ReadRequest(BaseModel):
    read: bool = True


class ReadAllRequest(BaseModel):
    source: str


class PriorityRequest(BaseModel):
    on: bool




class GeminiSettingsRequest(BaseModel):
    key: str | None = Field(default=None, min_length=10, max_length=200)
    model: str | None = Field(default=None, max_length=120, pattern=r"^[\w.:/@-]+$")
    mailAllowed: bool | None = None
    provider: Literal["gemini", "openrouter", "custom"] | None = None
    baseUrl: str | None = Field(default=None, max_length=200)


TURNS_KEPT = 8
POLL_WAIT_SECONDS = 20.0
POLL_CHECK_SECONDS = 0.5
POLL_COOLDOWN_SECONDS = 60  # pulling again and again must not hammer Canvas and the mail server


def is_outgoing(key: str) -> bool:
    return key.startswith((OUTGOING_PREFIX, SENT_PREFIX))


def blank_warning(body: str) -> list[str]:
    return [BLANKS] if BLANK.search(body) else []


def event_json(row: Any, item: Any = None, school_domain: str = "") -> dict[str, Any]:
    """An event is what happened then; `current` is its item now, so the app can say what still holds."""
    mail = item is not None and item["kind"] == "mail"
    return {
        "id": row["id"], "itemKey": row["item_key"], "type": row["type"], "level": row["level"],
        "title": row["title"], "body": row["body"], "url": row["url"], "createdAt": row["created_at"],
        "read": row["read_at"] is not None, "source": event_source(row["item_key"]),
        # Mail: the conversation it belongs to, as the phone groups it (mobile/src/mailThread.ts).
        "thread": (item["thread"] or None) if mail else None,
        "outgoing": is_outgoing(row["item_key"]),
        "hasFiles": bool(Store.attachments(item)) if mail else False,
        "fromSchool": bool(mail and item["reply_to"] and is_school_address(item["reply_to"], school_domain)),
        "current": {
            "title": item["title"], "course": item["course"], "dueAt": item["due_at"],
            "submitted": bool(item["submitted"]), "grade": item["grade"], "postedAt": item["posted_at"],
        } if item is not None else None,
    }


def exam_json(row: Any) -> dict[str, Any]:
    return {
        "key": f"exam:{row['course']}:{row['kind']}:{row['number']}", "course": row["course"], "kind": row["kind"],
        "number": row["number"], "startsOn": row["starts_on"], "endsOn": row["ends_on"], "status": row["status"],
        "week": row["week"], "source": row["source"], "evidence": row["evidence"], "url": row["url"],
    }


def exam_task(exam: Any) -> tuple[str, str]:
    """An exam's course and date say it all, so no model is involved."""
    name = {"midterm": "Vize", "final": "Final"}.get(exam["kind"], "Quiz")
    name += f" {exam['number']}" if exam["number"] else ""
    guessed = exam["status"] == "estimated"
    week = f"Tahmini tarih: {exam['week']}. hafta. Kesinleşince kontrol et." if guessed else ""
    title = f"{exam['course']}: {name}{' (tahmini)' if guessed else ''}"
    return title, "\n".join(part for part in (week, exam["url"]) if part)


def draft_json(row: Any) -> dict[str, Any]:
    warnings = [line for line in (row["warnings"] or "").split("\n") if line and line != BLANKS]
    return {
        "id": row["id"], "to": row["recipient"], "subject": row["subject"], "body": row["body"],
        "hash": draft_hash(row["recipient"], row["subject"], row["body"]), "createdAt": row["created_at"],
        # Looked at again each time, so it holds for drafts the agent wrote and goes once the student fills them.
        "warnings": warnings + blank_warning(f"{row['subject']}\n{row['body']}"),
    }


def create_app(
    settings: Settings | None = None,
    llm: Any = None,
    send: Any = None,
    tasks: Any = None,
    calendar: Any = None,
    gemini: Any = None,
    gemini_lister: Any = None,
    cloud_lister: Any = None,
) -> FastAPI:
    """`llm` is the local model, or None for a Gemini-only server. `send` hands an approved mail to the sending
    sandbox (mailsend.MailSender); tests pass their own. `gemini` and `gemini_lister` are for tests."""
    settings = settings or Settings.from_env()
    if llm is None and settings.local_llm_url:
        llm = LlmClient(settings.local_llm_url, settings.gpu_gate_url)
    send = send or MailSender(settings.mail_sender)
    if tasks is None and settings.google_tasks:
        tasks = GoogleTasks(GoogleCredentials.parse(settings.google_tasks))
    if calendar is None and settings.google_tasks:
        credentials = GoogleCredentials.parse(settings.google_tasks)
        if has_calendar(credentials):
            calendar = GoogleCalendar(credentials, getattr(settings.timezone, "key", "UTC"))
    injected_gemini = gemini
    list_models = gemini_lister or gemini_models
    list_cloud = cloud_lister or cloud_models
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
        key, source = gemini_key()
        if not key:
            return None
        config = gemini_config()
        provider = "gemini" if source == "server" else config.get("provider", "gemini")
        return GeminiClient(key, gemini_model(), provider=provider, base_url=config.get("baseUrl", ""))

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
        def work(r: Any) -> dict[str, Any]:
            return {
                "key": r["key"], "kind": r["kind"], "title": r["title"], "course": r["course"], "url": r["url"],
                "dueAt": r["due_at"], "inTasks": store.get_meta(f"gtask:{r['key']}") is not None,
            }

        upcoming = [work(r) for r in store.upcoming(now, now + timedelta(days=UPCOMING_DAYS))]
        # Canvas quizzes also go under Sınavlar. Their own field, so an app that knows only midterms and finals
        # never shows one as an exam. A quiz named after a midterm or final is that exam already.
        quizzes = [
            work(r) for r in store.upcoming(now, now + timedelta(days=QUIZ_DAYS))
            if r["kind"] == "quiz" and not is_exam_title(r["title"])
        ]
        today_here = now.astimezone(settings.timezone).date()
        coming = [
            {**exam_json(row), "inTasks": store.get_meta(f"gtask:{exam_json(row)['key']}") is not None}
            for row in store.exams()
            if date.fromisoformat(row["ends_on"] or row["starts_on"]) >= today_here
        ]

        def same_quiz(found: dict[str, Any], quiz: dict[str, Any]) -> bool:
            """An announced quiz that Canvas also lists: same course, and the same number or the same day."""
            day = to_time(quiz["dueAt"]).astimezone(settings.timezone).date().isoformat()
            number = quiz_number(quiz["title"])
            return quiz["course"] == found["course"] and (
                day == found["startsOn"] or (found["number"] > 0 and number == found["number"])
            )

        # Quizzes found in announcements, in a field of their own too: an older app would call any other kind a final.
        # One Canvas also lists shows once, as the Canvas quiz, which knows the hour.
        quiz_exams = [
            exam for exam in coming if exam["kind"] == "quiz" and not any(same_quiz(exam, quiz) for quiz in quizzes)
        ]
        coming = [exam for exam in coming if exam["kind"] != "quiz"]
        missing = [
            {"course": row["course"], "hint": row["hint"]} for row in store.exam_courses()
            if not row["has_syllabus"] and not any(exam["course"] == row["course"] for exam in coming)
        ]
        return {
            "upcoming": upcoming, "pendingDrafts": len(store.pending_drafts()), "gpu": gpu_state(),
            "tasksEnabled": tasks is not None, "exams": coming, "quizzes": quizzes,
            "quizExams": quiz_exams, "examsMissing": missing,
            "tasksOutdated": outdated_tasks(store) if tasks is not None else [],
        }

    @app.get("/v1/settings/syllabus-check", dependencies=guarded)
    def syllabus_check(store: Db) -> dict[str, int]:
        return {"days": int(store.get_meta("syllabus_check_days") or DEFAULT_CHECK_DAYS)}

    @app.post("/v1/settings/syllabus-check", dependencies=guarded)
    def set_syllabus_check(request: SyllabusCheckRequest, store: Db) -> dict[str, int]:
        if request.days not in CHECK_DAY_CHOICES:
            raise HTTPException(400, "geçersiz seçenek")
        store.set_meta("syllabus_check_days", str(request.days))
        return {"days": request.days}

    @app.post("/v1/tasks", dependencies=guarded)
    def add_task(request: TaskRequest, store: Db) -> dict[str, str]:
        """Puts a Canvas item into the student's Google Tasks, once."""
        if tasks is None:
            raise HTTPException(409, "Google Tasks bağlı değil")
        marker = f"gtask:{request.key}"
        exam = next((r for r in store.exams() if exam_json(r)["key"] == request.key), None)
        row = None if exam else store.get_item(request.key)
        if exam is None and row is None:
            raise HTTPException(404, "kayıt bulunamadı")
        if store.get_meta(marker):
            return {"status": "exists"}
        if exam:
            title, notes = exam_task(exam)
            day = date.fromisoformat(exam["starts_on"])
        else:
            due = to_time(row["due_at"])
            day = due.astimezone(settings.timezone).date() if due else None
            origin = f"{row['course']}: {row['title']}" if row["course"] else row["title"]
            title, notes = origin, row["url"]
        if request.title is not None and row is not None:
            title = clean_title(request.title)
            if not title:
                raise HTTPException(422, "Görev metni boş olamaz, bağlantı da içeremez")
            notes = "\n".join(part for part in (origin, row["url"]) if part)
            day = request.due or day
        try:
            task_id = tasks.add(title, notes, day)
        except GoogleTasksError as error:
            raise HTTPException(502, str(error)) from error
        except httpx.HTTPError as error:
            raise HTTPException(502, "Google Tasks'a ulaşılamadı") from error
        store.set_meta(marker, task_id)
        # A day the student chose is theirs: only a day taken from the item or the exam can later go out of date.
        if day and request.due is None:
            store.set_meta(f"{TASK_DUE}{request.key}", day.isoformat())
        return {"status": "added"}

    def task_source(store: Store, key: str) -> tuple[date | None, str, Any]:
        """The day an added task should have now, its name, and the exam behind it if there is one."""
        exam = next((r for r in store.exams() if exam_json(r)["key"] == key), None)
        if exam:
            return date.fromisoformat(exam["starts_on"]), exam_task(exam)[0], exam
        row = store.get_item(key)
        if row is None:
            return None, "", None
        due = to_time(row["due_at"])
        name = f"{row['course']}: {row['title']}" if row["course"] else row["title"]
        return (due.astimezone(settings.timezone).date() if due else None), name, None

    def outdated_tasks(store: Store) -> list[dict[str, str]]:
        today_here = datetime.now(UTC).astimezone(settings.timezone).date()
        found = []
        for meta, added_for in store.metas(TASK_DUE):
            key = meta.removeprefix(TASK_DUE)
            current, name, _ = task_source(store, key)
            if current and current >= today_here and current.isoformat() != added_for and store.get_meta(f"gtask:{key}"):
                found.append({"key": key, "title": name, "from": added_for, "to": current.isoformat()})
        return found

    @app.post("/v1/tasks/update", dependencies=guarded)
    def update_task(request: TaskKey, store: Db) -> dict[str, str]:
        """Only when the student says so. Moves the task to the day the item or exam has now."""
        if tasks is None:
            raise HTTPException(409, "Google Tasks bağlı değil")
        marker = f"gtask:{request.key}"
        task_id = store.get_meta(marker)
        current, _, exam = task_source(store, request.key)
        if not task_id or current is None:
            raise HTTPException(404, "görev bulunamadı")
        # An exam's name can change with its date ("tahmini" goes away). An item keeps the wording the student chose.
        title, notes = exam_task(exam) if exam else (None, None)
        try:
            alive = tasks.update(task_id, current, title, notes)
        except GoogleTasksError as error:
            raise HTTPException(502, str(error)) from error
        except httpx.HTTPError as error:
            raise HTTPException(502, "Google Tasks'a ulaşılamadı") from error
        if not alive:
            store.delete_meta(marker)
            store.delete_meta(f"{TASK_DUE}{request.key}")
            return {"status": "gone"}
        store.set_meta(f"{TASK_DUE}{request.key}", current.isoformat())
        return {"status": "updated"}

    @app.post("/v1/tasks/keep", dependencies=guarded)
    def keep_task(request: TaskKey, store: Db) -> dict[str, str]:
        """The student said leave it: asks again only if the date changes once more."""
        current, _, _ = task_source(store, request.key)
        if current is None or not store.get_meta(f"gtask:{request.key}"):
            raise HTTPException(404, "görev bulunamadı")
        store.set_meta(f"{TASK_DUE}{request.key}", current.isoformat())
        return {"status": "kept"}

    @app.post("/v1/tasks/suggest", dependencies=guarded)
    def suggest_task(request: TaskKey, store: Db) -> dict[str, Any]:
        """Only when the student taps for it, and it adds nothing: see suggest.py. The same model rules as chat."""
        if tasks is None:
            raise HTTPException(409, "Google Tasks bağlı değil")
        row = store.get_item(request.key)
        if row is None:
            raise HTTPException(404, "kayıt bulunamadı")
        model = llm
        if model is None:
            model = current_gemini()
            if model is None:
                raise HTTPException(409, "Model bağlı değil, görevi kendin yazabilirsin")
            if row["kind"] == "mail" and not mail_to_gemini():
                raise HTTPException(409, "Mailler Gemini'ye kapalı, görevi kendin yazabilirsin")
        today = datetime.now(UTC).astimezone(settings.timezone).date()
        try:
            options = suggest_tasks(model, row["title"], row["course"], row["sender"], row["body"], today)
        except LlmBusy as busy:
            raise HTTPException(503, str(busy)) from busy
        return {"options": options}

    @app.post("/v1/calendar/suggest", dependencies=guarded)
    def suggest_calendar(request: TaskKey, store: Db) -> dict[str, Any]:
        """Only when the student taps for it, and it adds nothing: the model reads the text and proposes events.
        It needs no Google connection: without one, the phone opens its own calendar app with the chosen event."""
        row = store.get_item(request.key)
        if row is None:
            raise HTTPException(404, "kayıt bulunamadı")
        model = llm
        if model is None:
            model = current_gemini()
            if model is None:
                raise HTTPException(409, "Model bağlı değil")
            if row["kind"] == "mail" and not mail_to_gemini():
                raise HTTPException(409, "Mailler Gemini'ye kapalı")
        today = datetime.now(UTC).astimezone(settings.timezone).date()
        try:
            events = suggest_events(model, row["title"], row["course"], row["sender"], row["body"], today)
        except LlmBusy as busy:
            raise HTTPException(503, str(busy)) from busy
        return {"events": events}

    @app.post("/v1/calendar", dependencies=guarded)
    def add_event(request: CalendarRequest, store: Db) -> dict[str, str]:
        """Puts the one event the student chose into their Google Calendar, once."""
        if calendar is None:
            raise HTTPException(409, "Google Takvim bağlı değil")
        row = store.get_item(request.key)
        if row is None:
            raise HTTPException(404, "kayıt bulunamadı")
        today = datetime.now(UTC).astimezone(settings.timezone).date()
        event = clean_event(request.model_dump(), today)
        if event is None:
            raise HTTPException(422, "Etkinliğin adı ve günü geçerli olmalı, bağlantı içermemeli")
        fingerprint = hashlib.sha256(f"{event['title']}|{event['start']}".encode()).hexdigest()[:16]
        marker = f"gcal:{request.key}:{fingerprint}"
        if store.get_meta(marker):
            return {"status": "exists"}
        origin = f"{row['course']}: {row['title']}" if row["course"] else row["title"]
        try:
            event_id = calendar.add(event["title"], event["start"], event["end"], event["location"], f"Kamil: {origin}")
        except GoogleTasksError as error:
            raise HTTPException(502, str(error)) from error
        except httpx.HTTPError as error:
            raise HTTPException(502, "Google Takvim'e ulaşılamadı") from error
        store.set_meta(marker, event_id)
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
        store.delete_meta(f"{TASK_DUE}{request.key}")
        return {"status": "removed"}

    @app.get("/v1/events", dependencies=guarded)
    def events(store: Db, limit: int = 120) -> list[dict[str, Any]]:
        return [
            event_json(row, store.get_item(row["item_key"]), settings.school_domain)
            for row in store.recent_events(min(limit, 200))
        ]

    @app.get("/v1/grades", dependencies=guarded)
    def grades(store: Db) -> dict[str, Any]:
        """Canvas's Grades tables as the last watcher round saw them. Showing them adds no notification."""
        raw = store.get_meta("gradebook")
        return json.loads(raw) if raw else {"updatedAt": None, "courses": []}

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

    @app.post("/v1/events/read-all", dependencies=guarded)
    def read_all(request: ReadAllRequest, store: Db) -> dict[str, str]:
        if request.source not in ("canvas", "mail"):
            raise HTTPException(400, "bilinmeyen liste")
        store.mark_all_read(request.source, datetime.now(UTC))
        return {"status": "read"}

    @app.post("/v1/events/{event_id}/read", dependencies=guarded)
    def set_read(event_id: int, request: ReadRequest, store: Db) -> dict[str, str]:
        store.set_event_read(event_id, request.read, datetime.now(UTC))
        return {"status": "read" if request.read else "unread"}

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
            # Mail: where a reply goes. The sender's own address, never a Reply-To the mail asked for.
            "replyTo": (row["reply_to"] or None) if row["kind"] == "mail" else None,
            "inTasks": store.get_meta(f"gtask:{row['key']}") is not None,
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
            label = PROVIDER_NAMES.get(getattr(gemini, "provider", "gemini"), "Bulut model")
            name = label if llm is not None else "Kamil"
            models.append({"id": "gemini", "name": name, "detail": f"{gemini.model}. Bulutta. {mail}."})
        first = (settings.student_name or "").split()
        return {
            "firstName": first[0].capitalize() if first else None,
            "models": models,
            "schoolDomain": settings.school_domain,
            "webmailUrl": settings.webmail_url,
            "features": {"localModel": llm is not None, "gpuGate": bool(gate), "tasks": tasks is not None, "calendar": calendar is not None},
        }

    @app.get("/v1/settings/gemini", dependencies=guarded)
    def gemini_settings() -> dict[str, Any]:
        key, source = gemini_key()
        config = gemini_config()
        provider = "gemini" if source == "server" else config.get("provider", "gemini")
        return {"provider": provider, "baseUrl": config.get("baseUrl", ""), "connected": key is not None, "source": source, "model": gemini_model(), "mailAllowed": mail_to_gemini()}

    @app.put("/v1/settings/gemini", dependencies=guarded)
    def set_gemini_settings(request: GeminiSettingsRequest) -> dict[str, Any]:
        """A new key is checked with Google first, and kept only if Google accepts it."""
        config = gemini_config()
        provider = request.provider or config.get("provider", "gemini")
        if request.provider and request.provider != config.get("provider", "gemini") and request.key is None:
            raise HTTPException(400, "Yeni sağlayıcı için anahtarını da gir")
        if request.baseUrl is not None:
            base_url = clean_base_url(request.baseUrl)
            if base_url is None:
                raise HTTPException(400, "Servis adresini https:// ile yaz")
            config["baseUrl"] = base_url
        if request.key is not None:
            if settings.gemini_key:
                raise HTTPException(409, "anahtar sunucuda ayarlı, uygulamadan değiştirilemez")
            key = request.key.strip()
            if provider == "custom" and not config.get("baseUrl"):
                raise HTTPException(400, "Servis adresini https:// ile yaz")
            try:
                if provider == "gemini":
                    available = list_models(key)
                else:
                    available = [option["id"] for option in list_cloud(provider, key, config.get("baseUrl", ""))]
            except LlmBusy as error:
                raise HTTPException(400, str(error)) from error
            config["key"] = key
            config["provider"] = provider
            if request.model is None and provider != "gemini" and available:
                config["model"] = available[0]
            elif request.model is None and available and gemini_model() not in available:
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

    @app.get("/v1/settings/cloud/models", dependencies=guarded)
    def cloud_model_list() -> list[dict[str, Any]]:
        """Each model with what is known of its limits, for the picker."""
        key, source = gemini_key()
        if key is None:
            raise HTTPException(409, "Model anahtarı yok")
        config = gemini_config()
        provider = "gemini" if source == "server" else config.get("provider", "gemini")
        try:
            return list_cloud(provider, key, config.get("baseUrl", ""))
        except LlmBusy as error:
            raise HTTPException(502, str(error)) from error

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

    def can_send() -> bool:
        available = getattr(send, "available", None)
        return bool(settings.smtp_host) and (available() if callable(available) else True)

    def first_name() -> str | None:
        first = (settings.student_name or "").split()
        return first[0].capitalize() if first else None

    def approved(store: Store, draft_id: str, seen: str) -> Any:
        """The draft exactly as the student saw it, still waiting; anything else is refused."""
        row = store.get_draft(draft_id)
        if row is None:
            raise HTTPException(404, "taslak bulunamadı")
        if not hmac.compare_digest(seen, draft_hash(row["recipient"], row["subject"], row["body"])):
            raise HTTPException(409, "taslak onayladığın halinden farklı")
        if row["status"] != "pending":
            raise HTTPException(409, "taslak zaten işlendi")
        return row

    def deliver(store: Store, row: Any) -> dict[str, Any]:
        """Sends a draft this request has claimed. On failure it waits again in Onaylar, so nothing is lost."""
        draft_id = row["id"]
        try:
            to = recipients(row["recipient"])
            result = send(OutgoingMail(
                to, row["subject"], row["body"], row["in_reply_to"], reply_references(row["refs"], row["in_reply_to"]),
            ))
        except MailSendError as error:
            store.set_draft_status(draft_id, "pending")
            raise HTTPException(502, str(error)) from error
        except Exception as error:  # noqa: BLE001 - the draft goes back so nothing is lost
            store.set_draft_status(draft_id, "pending")
            raise HTTPException(502, "Mail gönderilemedi.") from error
        store.set_draft_status(draft_id, "sent")
        # It shows in its conversation at once; when the Sent folder is read, its Message-ID keeps it from showing twice.
        now = datetime.now(UTC)
        key = f"{SENT_PREFIX}{draft_id}"
        store.upsert(Item(
            key=key, kind="mail", title=row["subject"], sender="Sen", body=row["body"], posted_at=now, level=NORMAL,
            thread=row["thread"] or f"s:{plain_subject(row['subject'])}", reply_to=to[0],
            message_id=result.message_id, references=row["refs"],
        ), now)
        store.add_quiet_event(key, f"Mail: {row['subject']}", f"Kime: {row['recipient']}", now)
        return {"status": "sent", "sentCopy": result.sent_copy}

    def mail_row(store: Store, key: str) -> Any:
        row = store.get_item(key)
        if row is None or row["kind"] != "mail":
            raise HTTPException(404, "Mail bulunamadı")
        return row

    @app.post("/v1/drafts/{draft_id}/send", dependencies=guarded)
    def send_draft(draft_id: str, request: SendRequest, store: Db) -> dict[str, Any]:
        """Only from the student's tap in Onaylar, and only what they saw."""
        approved(store, draft_id, request.hash)
        if not store.claim_draft(draft_id, "sending"):
            raise HTTPException(409, "taslak zaten işlendi")
        return deliver(store, store.get_draft(draft_id))

    @app.put("/v1/drafts/{draft_id}", dependencies=guarded)
    def update_draft(draft_id: str, request: DraftChange, store: Db) -> dict[str, Any]:
        """The student's own edit. What was warned about the text is looked at again; what was warned about
        where it came from stays."""
        row = approved(store, draft_id, request.hash)
        kept = tuple(line for line in (row["warnings"] or "").split("\n") if line and line != BLANKS)
        subject = re.sub(r"[\r\n]+", " ", request.subject).strip()[:300]
        if not store.update_draft(draft_id, request.to.strip()[:300], subject, request.body[:20000], kept):
            raise HTTPException(409, "taslak zaten işlendi")
        return draft_json(store.get_draft(draft_id))

    @app.post("/v1/drafts/{draft_id}/opened", dependencies=guarded)
    def opened_draft(draft_id: str, request: SendRequest, store: Db) -> dict[str, str]:
        """The app opened it in the phone's mail app: from there the student sends it, so it leaves Onaylar."""
        approved(store, draft_id, request.hash)
        if not store.claim_draft(draft_id, "opened"):
            raise HTTPException(409, "taslak zaten işlendi")
        return {"status": "opened"}

    @app.get("/v1/mail/can-send", dependencies=guarded)
    def mail_can_send() -> dict[str, bool]:
        """Whether Onaylar can send by itself. Without it, drafts open in the phone's mail app."""
        return {"canSend": can_send()}

    @app.post("/v1/mail/reply-text", dependencies=guarded)
    def reply_text(request: ReplyKey, store: Db) -> dict[str, str]:
        """Text for a reply, from the whole conversation, when the student taps for it. It only fills the box:
        nothing is saved or sent. The local model writes it; a cloud model only if mail may go there."""
        row = mail_row(store, request.key)
        thread = store.thread_mail(row["thread"], REPLY_THREAD) if row["thread"] else []
        mails = [{"sender": r["sender"], "title": r["title"], "body": r["body"]} for r in thread or [row]]
        cloud = current_gemini() if mail_to_gemini() else None
        if llm is None and cloud is None:
            if current_gemini() is None:
                raise HTTPException(409, "Model bağlı değil, yanıtı kendin yazabilirsin.")
            raise HTTPException(409, "Mailler bulut modele kapalı. Ayarlar'dan açabilir veya yanıtı kendin yazabilirsin.")
        try:
            try:
                body = write_reply(llm or cloud, mails, first_name())
            except LlmBusy:
                if llm is None or cloud is None:
                    raise
                body = write_reply(cloud, mails, first_name())  # the GPU is lent out, and mail may go to the cloud
        except LlmBusy as busy:
            raise HTTPException(503, str(busy)) from busy
        if not body:
            raise HTTPException(503, "Model boş yanıt verdi, tekrar dene.")
        return {"body": body}

    def save_reply(store: Store, request: ReplyRequest) -> Any:
        row = mail_row(store, request.key)
        draft_id = store.create_draft(
            request.to.strip()[:300], reply_subject(row["title"])[:300], request.body[:20000], datetime.now(UTC),
            tuple(blank_warning(request.body)), thread=row["thread"], in_reply_to=row["message_id"], refs=row["refs"],
        )
        return store.get_draft(draft_id)

    @app.post("/v1/mail/reply", dependencies=guarded)
    def reply(request: ReplyRequest, store: Db) -> dict[str, Any]:
        """A reply as the student wrote it, waiting in Onaylar."""
        return draft_json(save_reply(store, request))

    @app.post("/v1/mail/reply/send", dependencies=guarded)
    def reply_send(request: ReplyRequest, store: Db) -> dict[str, Any]:
        """Sent straight from the box, after the student confirmed. If it fails nothing stays behind: the text is
        still in the box."""
        row = save_reply(store, request)
        if not store.claim_draft(row["id"], "sending"):
            raise HTTPException(409, "taslak zaten işlendi")
        try:
            return deliver(store, row)
        except HTTPException:
            store.set_draft_status(row["id"], "discarded")
            raise

    @app.post("/v1/drafts/{draft_id}/discard", dependencies=guarded)
    def discard_draft(draft_id: str, store: Db) -> dict[str, str]:
        if not store.claim_draft(draft_id, "discarded"):
            raise HTTPException(409, "taslak zaten işlendi")
        return {"status": "discarded"}

    @app.get("/v1/gpu", dependencies=guarded)
    def gpu(store: Db) -> dict[str, Any]:
        if not gate:
            raise HTTPException(404, "bu sunucuda GPU kapısı yok")
        midnight = datetime.now(settings.timezone).replace(hour=0, minute=0, second=0, microsecond=0)
        return {**gpu_state(), "lastPollAt": store.get_meta("last_poll_at"), "today": store.work_since(midnight)}

    @app.post("/v1/gpu/priority", dependencies=guarded)
    def set_priority(request: PriorityRequest) -> dict[str, Any]:
        """The student needs the local model now: work sharing the GPU steps aside for a while."""
        if not gate:
            raise HTTPException(404, "bu sunucuda GPU kapısı yok")
        try:
            answer = httpx.post(f"{gate}/priority", json={"on": request.on}, timeout=25.0)
        except httpx.HTTPError as error:
            raise HTTPException(503, "GPU kapısına ulaşılamıyor") from error
        if answer.status_code != 200:
            raise HTTPException(409, answer.json().get("reason") or "öncelik verilemedi")
        return answer.json()

    @app.post("/v1/gpu", dependencies=guarded)
    def set_gpu(request: ModeRequest) -> dict[str, Any]:
        if not gate:
            raise HTTPException(404, "bu sunucuda GPU kapısı yok")
        if request.mode not in GPU_MODES:
            raise HTTPException(400, "mode must be assistant or compute")
        try:
            answer = httpx.post(f"{gate}/mode", json={"mode": request.mode, "confirm": request.confirm}, timeout=25.0)
        except httpx.HTTPError as error:
            raise HTTPException(503, "GPU kapısına ulaşılamıyor") from error
        if answer.status_code != 200:
            raise HTTPException(409, answer.json().get("reason") or "mod değiştirilemedi")
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
