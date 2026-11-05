from __future__ import annotations

import json
from datetime import date

import httpx
import pytest

from ai_ders.gtasks import TASKS_URL, TOKEN_URL, GoogleCredentials, GoogleTasks, GoogleTasksError

CREDS = GoogleCredentials("id", "secret", "refresh")


def client_for(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_task_is_created_with_a_fresh_token_and_only_the_due_date():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if str(request.url) == TOKEN_URL:
            assert b"grant_type=refresh_token" in request.content and b"refresh_token=refresh" in request.content
            return httpx.Response(200, json={"access_token": "tok"})
        assert str(request.url) == TASKS_URL
        assert request.headers["Authorization"] == "Bearer tok"
        assert json.loads(request.content) == {
            "title": "COMP303: HW1", "notes": "https://canvas/a/1", "due": "2026-11-04T00:00:00.000Z",
        }
        return httpx.Response(200, json={"id": "task-1"})

    tasks = GoogleTasks(CREDS, client_for(handler))
    assert tasks.add("COMP303: HW1", "https://canvas/a/1", date(2026, 11, 4)) == "task-1"
    assert len(seen) == 2


def test_task_without_a_due_date_has_none():
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_URL:
            return httpx.Response(200, json={"access_token": "tok"})
        assert "due" not in json.loads(request.content)
        return httpx.Response(200, json={"id": "task-2"})

    assert GoogleTasks(CREDS, client_for(handler)).add("Duyuru", "", None) == "task-2"


@pytest.mark.parametrize("status", [204, 404, 410])
def test_removing_a_task_also_accepts_one_already_gone(status):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_URL:
            return httpx.Response(200, json={"access_token": "tok"})
        seen.append((request.method, str(request.url)))
        return httpx.Response(status)

    GoogleTasks(CREDS, client_for(handler)).remove("a/b")
    assert seen == [("DELETE", f"{TASKS_URL}/a%2Fb")]


def test_failed_removal_is_an_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_URL:
            return httpx.Response(200, json={"access_token": "tok"})
        return httpx.Response(500)

    with pytest.raises(httpx.HTTPStatusError):
        GoogleTasks(CREDS, client_for(handler)).remove("t")


def test_revoked_permission_says_to_reconnect():
    tasks = GoogleTasks(CREDS, client_for(lambda request: httpx.Response(400, json={"error": "invalid_grant"})))
    with pytest.raises(GoogleTasksError, match="yeniden kur"):
        tasks.add("x", "", None)


def test_credentials_round_trip():
    raw = json.dumps({"client_id": "a", "client_secret": "b", "refresh_token": "c"})
    assert GoogleCredentials.parse(raw) == GoogleCredentials("a", "b", "c")


def test_the_downloaded_client_file_gives_the_id_and_secret(tmp_path):
    import json

    from ai_ders.gtasks import GoogleTasksError, read_client_file

    path = tmp_path / "client.json"
    path.write_text(json.dumps({"installed": {"client_id": "id.apps", "client_secret": "s3"}}))
    assert read_client_file(str(path)) == ("id.apps", "s3")
    path.write_text("{}")
    import pytest

    with pytest.raises(GoogleTasksError):
        read_client_file(str(path))
