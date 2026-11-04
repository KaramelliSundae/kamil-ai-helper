from __future__ import annotations

import httpx
import pytest

from ai_ders.canvas import (
    MAX_PAGES,
    CanvasAuthError,
    CanvasClient,
    CanvasError,
    assignment_item,
    next_link,
    planner_item,
)

BASE = "https://canvas.uni.example.edu"


def client_for(handler) -> CanvasClient:
    return CanvasClient(BASE, "token", transport=httpx.MockTransport(handler))


def test_client_exposes_no_write_methods():
    public = {name for name in vars(CanvasClient) if not name.startswith("_")}
    assert not public & {"post", "put", "patch", "delete", "submit"}


def test_every_request_is_a_get_with_the_token():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[{"id": 1, "name": "COMP303"}])

    assert client_for(handler).courses() == {1: "COMP303"}
    assert [r.method for r in seen] == ["GET"]
    assert seen[0].headers["authorization"] == "Bearer token"


def test_pagination_follows_the_next_link():
    def handler(request: httpx.Request) -> httpx.Response:
        if "page=2" in str(request.url):
            return httpx.Response(200, json=[{"id": 2, "name": "B"}])
        link = f'<{BASE}/api/v1/courses?page=2>; rel="next", <{BASE}/api/v1/courses?page=2>; rel="last"'
        return httpx.Response(200, json=[{"id": 1, "name": "A"}], headers={"Link": link})

    assert client_for(handler).courses() == {1: "A", 2: "B"}


def test_token_is_never_sent_to_another_host():
    hosts = []

    def handler(request: httpx.Request) -> httpx.Response:
        hosts.append(request.url.host)
        return httpx.Response(200, json=[], headers={"Link": '<https://evil.example/x>; rel="next"'})

    with pytest.raises(CanvasError):
        client_for(handler).courses()
    assert hosts == ["canvas.uni.example.edu"]


def test_endless_pagination_stops_with_an_error():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=[], headers={"Link": f'<{BASE}/api/v1/courses?page=2>; rel="next"'})

    with pytest.raises(CanvasError):
        client_for(handler).courses()
    assert len(calls) == MAX_PAGES


def test_refused_token_is_a_distinct_error():
    with pytest.raises(CanvasAuthError):
        client_for(lambda request: httpx.Response(401)).courses()


def test_network_failure_is_a_canvas_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    with pytest.raises(CanvasError):
        client_for(handler).courses()


def test_next_link_ignores_other_relations():
    assert next_link('<a>; rel="current", <b>; rel="last"') is None
    assert next_link(None) is None


def test_assignment_reads_the_students_submission():
    item = assignment_item(
        {
            "id": 7,
            "name": "HW1",
            "due_at": "2026-11-05T20:59:59Z",
            "description": "<p>Oku &amp; yaz</p>",
            "submission": {"workflow_state": "graded", "grade": "85", "submitted_at": "2026-11-01T10:00:00Z"},
        },
        "COMP303",
    )
    assert (item.key, item.kind, item.grade, item.submitted) == ("assignment:7", "assignment", "85", True)
    assert item.body == "Oku & yaz"
    assert item.due_at.isoformat() == "2026-11-05T20:59:59+00:00"


def test_unsubmitted_assignment_stays_open():
    item = assignment_item({"id": 7, "name": "HW1", "submission": {"workflow_state": "unsubmitted"}}, "C")
    assert item.submitted is False and item.grade is None


def test_quiz_shares_its_key_with_the_planner_record():
    assignment = assignment_item({"id": 7, "name": "Q", "quiz_id": 9, "submission_types": ["online_quiz"]}, "C")
    planner = planner_item(
        {"plannable_type": "quiz", "plannable_id": 9, "plannable": {"title": "Q"}, "plannable_date": "2026-11-05T20:00:00Z"},
        {},
    )
    assert assignment.key == planner.key == "quiz:9"
    assert assignment.kind == "quiz"


def test_planner_skips_records_with_a_richer_endpoint():
    assert planner_item({"plannable_type": "assignment", "plannable_id": 1}, {}) is None
    assert planner_item({"plannable_type": "announcement", "plannable_id": 1}, {}) is None


def test_own_canvas_reply_is_not_news():
    mine, theirs = "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                {"id": 1, "subject": "Sen", "last_message_at": mine, "last_authored_message_at": mine},
                {"id": 2, "subject": "Hoca", "last_message_at": theirs, "last_authored_message_at": mine},
            ],
        )

    assert [item.title for item in client_for(handler).messages()] == ["Hoca"]
