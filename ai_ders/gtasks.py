"""Adds tasks to the student's Google Tasks. The server keeps a refresh token for the tasks scope only.

Connected once with deploy/linux/connect-google-tasks.sh. Google revokes the refresh tokens of OAuth apps
left in "Testing" after 7 days, so the Google Cloud app has to be set to "In production".
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from datetime import date
from getpass import getpass
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlparse

import httpx

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
TASKS_URL = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks"
SCOPE = "https://www.googleapis.com/auth/tasks"
# Nothing listens here: after consent the browser shows an error page, and its address holds the code.
REDIRECT_URI = "http://127.0.0.1:8765"


class GoogleTasksError(Exception):
    pass


@dataclass(frozen=True)
class GoogleCredentials:
    client_id: str
    client_secret: str
    refresh_token: str

    @classmethod
    def parse(cls, raw: str) -> GoogleCredentials:
        data = json.loads(raw)
        return cls(data["client_id"], data["client_secret"], data["refresh_token"])


class GoogleTasks:
    def __init__(self, credentials: GoogleCredentials, client: httpx.Client | None = None):
        self.credentials = credentials
        self.client = client or httpx.Client(timeout=20.0)

    def _access_token(self) -> str:
        response = self.client.post(TOKEN_URL, data={
            "client_id": self.credentials.client_id,
            "client_secret": self.credentials.client_secret,
            "refresh_token": self.credentials.refresh_token,
            "grant_type": "refresh_token",
        })
        if response.status_code in (400, 401):
            raise GoogleTasksError("Google izni geçersiz, Google Tasks bağlantısını yeniden kur.")
        response.raise_for_status()
        return response.json()["access_token"]

    def add(self, title: str, notes: str, due: date | None) -> str:
        task: dict[str, str] = {"title": title, "notes": notes}
        if due:
            task["due"] = f"{due.isoformat()}T00:00:00.000Z"  # Google keeps only the date
        response = self.client.post(
            TASKS_URL, json=task, headers={"Authorization": f"Bearer {self._access_token()}"}
        )
        response.raise_for_status()
        return response.json()["id"]


    def update(self, task_id: str, due: date, title: str | None = None, notes: str | None = None) -> bool:
        """Moves a task to another day. False when it is gone from Google Tasks (deleted by hand)."""
        task: dict[str, str] = {"due": f"{due.isoformat()}T00:00:00.000Z"}
        if title is not None:
            task["title"] = title
        if notes is not None:
            task["notes"] = notes
        response = self.client.patch(
            f"{TASKS_URL}/{quote(task_id, safe='')}", json=task, headers={"Authorization": f"Bearer {self._access_token()}"}
        )
        if response.status_code in (404, 410):
            return False
        response.raise_for_status()
        return True

    def remove(self, task_id: str) -> None:
        """Already gone from Google Tasks (deleted by hand) counts as removed."""
        response = self.client.delete(
            f"{TASKS_URL}/{quote(task_id, safe='')}", headers={"Authorization": f"Bearer {self._access_token()}"}
        )
        if response.status_code not in (404, 410):
            response.raise_for_status()


def read_client_file(path: str) -> tuple[str, str]:
    """The JSON Google Cloud offers for download when the OAuth client is created."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        client = data.get("installed") or data.get("web") or data
        return client["client_id"], client["client_secret"]
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise GoogleTasksError(f"istemci dosyası okunamadı: {type(error).__name__}") from error


def authorize(client: httpx.Client | None = None, client_file: str | None = None) -> str:
    """One-time consent in the terminal. Prompts go to stderr; only the credentials JSON goes to stdout."""
    client = client or httpx.Client(timeout=20.0)
    say = sys.stderr.write
    if client_file:
        client_id, client_secret = read_client_file(client_file)
    else:
        say("Google Cloud'daki OAuth istemcisinin (Desktop app) bilgileri.\n")
        say("Client ID: ")
        sys.stderr.flush()
        client_id = sys.stdin.readline().strip()
        client_secret = getpass("Client secret (görünmez): ").strip()
    query = urlencode({
        "client_id": client_id, "redirect_uri": REDIRECT_URI, "response_type": "code", "scope": SCOPE,
        "access_type": "offline", "prompt": "consent",
    })
    say(f"\nBu adresi tarayıcıda aç ve izin ver:\n\n{AUTH_URL}?{query}\n\n")
    say("Sonunda açılmayan bir sayfaya gideceksin. Adres çubuğundaki tam adresi buraya yapıştır:\n")
    sys.stderr.flush()
    codes = parse_qs(urlparse(sys.stdin.readline().strip()).query).get("code")
    if not codes:
        raise GoogleTasksError("Adreste izin kodu yok.")
    response = client.post(TOKEN_URL, data={
        "code": codes[0], "client_id": client_id, "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI, "grant_type": "authorization_code",
    })
    if response.status_code != 200 or "refresh_token" not in response.json():
        raise GoogleTasksError(f"Google izin vermedi: {response.text[:200]}")
    return json.dumps({
        "client_id": client_id, "client_secret": client_secret, "refresh_token": response.json()["refresh_token"],
    })
