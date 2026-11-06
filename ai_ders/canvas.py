"""Canvas client.

A personal access token carries all of the account's rights, including submitting work. This client
therefore exposes GET only: there is no code path that can change anything on Canvas.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Iterator
from ipaddress import ip_address
from urllib.parse import urljoin, urlsplit

import httpx

from .models import Item
from .text import html_to_text

log = logging.getLogger(__name__)

PER_PAGE = 100
MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024
MAX_PAGES = 50
SUBMITTED_STATES = {"submitted", "pending_review", "graded"}
PLANNER_KINDS = {"quiz": "quiz", "discussion_topic": "discussion", "calendar_event": "event"}


class CanvasError(Exception):
    pass


class CanvasAuthError(CanvasError):
    """The token was refused: it expired, or it was revoked."""


def is_public_host(host: str) -> bool:
    """Not an address on this machine or its network, however a redirect may name it."""
    if not host or host == "localhost" or host.endswith((".local", ".internal", ".localhost")):
        return False
    try:
        return ip_address(host).is_global
    except ValueError:
        return True


def parse_time(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def next_link(header: str | None) -> str | None:
    for part in (header or "").split(","):
        sections = part.split(";")
        if any(section.strip() == 'rel="next"' for section in sections[1:]):
            return sections[0].strip().strip("<>")
    return None


class CanvasClient:
    def __init__(self, base_url: str, token: str, transport: httpx.BaseTransport | None = None):
        self.base_url = base_url.rstrip("/")
        self._origin = urlsplit(self.base_url)[:2]
        self._transport = transport
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30.0,
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def _pages(self, path: str, params: dict[str, Any] | None = None) -> Iterator[Any]:
        url: str | None = path
        query = {"per_page": PER_PAGE, **(params or {})}
        pages = 0
        while url:
            pages += 1
            if pages > MAX_PAGES:
                raise CanvasError(f"Canvas returned more than {MAX_PAGES} pages for {path}")
            try:
                response = self._client.get(url, params=query)
            except httpx.HTTPError as error:
                raise CanvasError(f"Canvas unreachable: {type(error).__name__}") from error
            if response.status_code == 401:
                raise CanvasAuthError("Canvas refused the token")
            if response.status_code >= 400:
                raise CanvasError(f"GET {urlsplit(str(response.url)).path}: HTTP {response.status_code}")
            yield response.json()
            url = next_link(response.headers.get("Link"))
            query = None  # the next link already carries the query
            # The token goes with every request, so never follow a link to another host.
            if url and urlsplit(url)[:2] != self._origin:
                raise CanvasError("Canvas pagination pointed at another host")

    def _list(self, path: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        return [row for page in self._pages(path, params) for row in page]

    def courses(self) -> dict[int, str]:
        rows = self._list("/api/v1/courses", {"enrollment_state": "active"})
        # A course the student cannot access comes back as only an id and an access_restricted flag.
        return {row["id"]: row.get("name") or str(row["id"]) for row in rows if not row.get("access_restricted_by_date")}

    def assignments(self, course_id: int, course: str) -> list[Item]:
        rows = self._list(f"/api/v1/courses/{course_id}/assignments", {"include[]": "submission"})
        return [assignment_item(row, course) for row in rows]

    def announcements(self, courses: dict[int, str], start: datetime, end: datetime) -> list[Item]:
        if not courses:
            return []
        params = {
            "context_codes[]": [f"course_{course_id}" for course_id in courses],
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
        }
        return [announcement_item(row, courses) for row in self._list("/api/v1/announcements", params)]

    def planner_items(self, courses: dict[int, str], start: datetime, end: datetime) -> list[Item]:
        rows = self._list("/api/v1/planner/items", {"start_date": start.isoformat(), "end_date": end.isoformat()})
        items = [planner_item(row, courses) for row in rows]
        return [item for item in items if item is not None]

    def course_info(self, course_id: int) -> dict[str, Any]:
        for page in self._pages(f"/api/v1/courses/{course_id}", {"include[]": ["syllabus_body", "term"]}):
            return page if isinstance(page, dict) else {}
        return {}

    def _optional_list(self, path: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """Many courses switch their files, pages or modules off, which is no failure of Canvas."""
        try:
            return self._list(path, params)
        except CanvasAuthError:
            raise
        except CanvasError:
            return []

    def front_page(self, course_id: int) -> str:
        try:
            for page in self._pages(f"/api/v1/courses/{course_id}/front_page"):
                return (page.get("body") or "") if isinstance(page, dict) else ""
        except CanvasAuthError:
            raise
        except CanvasError:
            pass
        return ""

    def course_files(self, course_id: int, search: str) -> list[dict[str, Any]]:
        return self._optional_list(f"/api/v1/courses/{course_id}/files", {"search_term": search})

    def module_items(self, course_id: int) -> list[dict[str, Any]]:
        modules = self._optional_list(f"/api/v1/courses/{course_id}/modules", {"include[]": "items"})
        return [item for module in modules for item in module.get("items") or []]

    def download(self, url: str) -> bytes | None:
        """A file Canvas itself named. Redirects are followed by hand: the token only ever goes to Canvas's own host, and
        storage elsewhere gets a plain request. Size limited, and any failure simply gives nothing."""
        try:
            with httpx.Client(timeout=60.0, follow_redirects=False, transport=self._transport) as plain:
                for _ in range(5):
                    parts = urlsplit(url)
                    own = parts[:2] == self._origin
                    if not own and (parts.scheme != "https" or not is_public_host(parts.hostname or "")):
                        return None
                    client = self._client if own else plain
                    with client.stream("GET", url) as response:
                        if 300 <= response.status_code < 400:
                            url = urljoin(url, response.headers.get("location", ""))
                            continue
                        if response.status_code != 200:
                            return None
                        data = bytearray()
                        for chunk in response.iter_bytes():
                            data += chunk
                            if len(data) > MAX_DOWNLOAD_BYTES:
                                return None
                        return bytes(data)
        except httpx.HTTPError:
            return None
        return None

    def messages(self) -> list[Item]:
        # Listing does not mark anything as read; only opening a single conversation does.
        page = next(self._pages("/api/v1/conversations", {"per_page": 30}))
        # The student's own reply also moves last_message_at; that is not news.
        return [
            message_item(row)
            for row in page
            if row.get("last_message_at") != row.get("last_authored_message_at")
        ]


def assignment_item(row: dict[str, Any], course: str) -> Item:
    submission = row.get("submission") or {}
    is_quiz = "online_quiz" in (row.get("submission_types") or []) or bool(row.get("is_quiz_assignment"))
    graded = submission.get("workflow_state") == "graded" and submission.get("grade") is not None
    # Quizzes and graded discussions also appear in the planner under their own id. Using that id
    # here gives both records the same key, so one task never produces two reminders.
    topic = row.get("discussion_topic") or {}
    if row.get("quiz_id"):
        key = f"quiz:{row['quiz_id']}"
    elif topic.get("id"):
        key = f"discussion:{topic['id']}"
    else:
        key = f"assignment:{row['id']}"
    return Item(
        key=key,
        kind="quiz" if is_quiz else "assignment",
        title=row.get("name") or "(adsız)",
        course=course,
        url=row.get("html_url") or "",
        body=html_to_text(row.get("description")),
        due_at=parse_time(row.get("due_at")),
        posted_at=parse_time(row.get("created_at")),
        grade=str(submission["grade"]) if graded else None,
        submitted=submission.get("workflow_state") in SUBMITTED_STATES or bool(submission.get("submitted_at")),
    )


def announcement_item(row: dict[str, Any], courses: dict[int, str]) -> Item:
    code = row.get("context_code") or ""
    course_id = int(code.split("_")[1]) if code.startswith("course_") else 0
    return Item(
        key=f"announcement:{row['id']}",
        kind="announcement",
        title=row.get("title") or "(başlıksız)",
        course=courses.get(course_id, ""),
        url=row.get("html_url") or "",
        sender=row.get("user_name") or (row.get("author") or {}).get("display_name") or "",
        body=html_to_text(row.get("message")),
        posted_at=parse_time(row.get("posted_at")),
    )


def planner_item(row: dict[str, Any], courses: dict[int, str]) -> Item | None:
    """Assignments and announcements have richer endpoints, so only the rest is taken from here."""
    kind = PLANNER_KINDS.get(row.get("plannable_type") or "")
    if kind is None:
        return None
    plannable = row.get("plannable") or {}
    submissions = row.get("submissions")
    return Item(
        key=f"{kind}:{row.get('plannable_id')}",
        kind=kind,
        title=plannable.get("title") or "(başlıksız)",
        course=row.get("context_name") or courses.get(row.get("course_id") or 0, ""),
        url=row.get("html_url") or "",
        due_at=parse_time(row.get("plannable_date")),
        submitted=bool(submissions.get("submitted")) if isinstance(submissions, dict) else False,
    )


def message_item(row: dict[str, Any]) -> Item:
    return Item(
        key=f"message:{row['id']}:{row.get('last_message_at')}",
        kind="message",
        title=row.get("subject") or "(konusuz)",
        course=row.get("context_name") or "",
        sender=", ".join(p.get("name", "") for p in (row.get("participants") or [])[:3]),
        body=row.get("last_message") or "",
        posted_at=parse_time(row.get("last_message_at")),
    )
