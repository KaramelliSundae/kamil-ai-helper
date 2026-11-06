"""Other providers than Gemini: what they are sent, what the picker says, and where a key may go."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from ai_ders.api import create_app
from ai_ders.llm import GeminiClient, LlmBusy, clean_base_url, cloud_models, gemini_options, openrouter_options, seen_limit

from .test_api import AUTH, api_settings, sends  # noqa: F401  (fixtures)


def client_for(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.mark.parametrize("url,want", [
    ("https://api.groq.com/openai/v1/", "https://api.groq.com/openai/v1"),
    ("http://127.0.0.1:8000/v1", "http://127.0.0.1:8000/v1"),
    ("http://192.168.1.5:1234", "http://192.168.1.5:1234"),
    ("http://evil.example/v1", None),
    ("ftp://x", None),
    ("https://x y", None),
    ("https://x/v1?key=1", None),
])
def test_a_key_crosses_the_internet_only_over_https(url, want):
    assert clean_base_url(url) == want


def test_openrouter_is_asked_for_providers_that_keep_nothing():
    seen = {}

    def handler(request):
        seen["url"], seen["body"], seen["auth"] = str(request.url), json.loads(request.content), request.headers["authorization"]
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    model = GeminiClient("k", "a/b:free", client_for(handler), provider="openrouter")
    assert model.chat([{"role": "user", "content": "x"}], [])["content"] == "ok"
    assert seen["url"] == "https://openrouter.ai/api/v1/chat/completions" and seen["auth"] == "Bearer k"
    assert seen["body"]["provider"] == {"data_collection": "deny", "require_parameters": True}
    assert "tools" not in seen["body"] and "k" not in seen["url"]


def test_a_custom_service_gets_its_own_address_and_no_openrouter_options():
    seen = {}

    def handler(request):
        seen["url"], seen["body"] = str(request.url), json.loads(request.content)
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    GeminiClient("k", "m", client_for(handler), provider="custom", base_url="https://x.example/v1").chat([], [{"t": 1}])
    assert seen["url"] == "https://x.example/v1/chat/completions" and "provider" not in seen["body"] and seen["body"]["tools"] == [{"t": 1}]


def test_a_429_names_the_limit_when_google_does():
    body = json.dumps({"error": {"details": [{"violations": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier", "quotaValue": "20"}]}]}})
    assert seen_limit(body) == "20 istek/gün"
    assert seen_limit(body.replace("PerDay", "PerMinute")) == "20 istek/dk"
    assert seen_limit(body.replace("GenerateRequests", "InputTokens")) is None
    assert seen_limit("nope") is None
    model = GeminiClient("k", "m", client_for(lambda r: httpx.Response(429, text=body)))
    with pytest.raises(LlmBusy, match="sınır: 20 istek/gün"):
        model.chat([], [])


def test_gemini_notes_say_approximate_or_point_to_ai_studio():
    models = [
        {"name": "models/gemini-3.5-flash-lite", "supportedGenerationMethods": ["generateContent"], "inputTokenLimit": 1048576},
        {"name": "models/gemini-3.8-flash", "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/gemini-9.9-flash", "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/gemini-3.8-flash-tts", "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/old", "supportedGenerationMethods": ["embedContent"]},
    ]
    options = {o["id"]: o["note"] for o in gemini_options(models)}
    assert list(options) == ["gemini-9.9-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite"]
    assert options["gemini-3.5-flash-lite"] == "yaklaşık 10 istek/dk, 500/gün · 1M bağlam"
    assert options["gemini-3.8-flash"].startswith("yaklaşık 5 istek/dk")
    assert options["gemini-9.9-flash"] == "Limit: AI Studio’da"


def test_openrouter_lists_free_models_first_with_what_is_left_today():
    models = [
        {"id": "z/paid", "pricing": {"prompt": "0.0000001", "completion": "0.0000004"}, "context_length": 128000},
        {"id": "a/free:free", "pricing": {"prompt": "0", "completion": "0"}},
        {"name": "no id"},
    ]
    options = openrouter_options(models, {"remaining": 42, "limit": 50})
    assert [o["id"] for o in options] == ["a/free:free", "z/paid"]
    assert options[0]["free"] is True and "42/50 hak kaldı" in options[0]["note"] and "20 istek/dk" in options[0]["note"]
    assert options[1]["note"] == "Ücretli · 1M token $0.10 / $0.40 · 128K bağlam"


def test_a_bad_openrouter_key_is_refused_before_the_list():
    with pytest.raises(LlmBusy, match="kabul etmedi"):
        cloud_models("openrouter", "bad", client=client_for(lambda r: httpx.Response(401)))


def test_choosing_a_provider_checks_the_key_and_keeps_it_private(api_settings, sends):
    calls = []

    def lister(provider, key, base):
        calls.append((provider, key, base))
        if key == "bad-key-here":
            raise LlmBusy("OpenRouter bu anahtarı kabul etmedi")
        return [{"id": "a/free:free", "note": "n", "free": True}]

    client = TestClient(create_app(api_settings, None, sends, cloud_lister=lister))
    refused = client.put("/v1/settings/gemini", json={"key": "bad-key-here", "provider": "openrouter"}, headers=AUTH)
    assert refused.status_code == 400 and not (api_settings.state_dir / "gemini.json").exists()
    saved = client.put("/v1/settings/gemini", json={"key": "sk-or-good-key", "provider": "openrouter"}, headers=AUTH).json()
    assert saved["provider"] == "openrouter" and saved["model"] == "a/free:free"
    assert "sk-or" not in client.get("/v1/settings/gemini", headers=AUTH).text
    assert client.get("/v1/settings/cloud/models", headers=AUTH).json()[0]["id"] == "a/free:free"
    assert client.get("/v1/chat/setup", headers=AUTH).json()["models"][0]["detail"].startswith("a/free:free")


def test_a_new_provider_needs_its_own_key_and_a_custom_one_a_safe_address(api_settings, sends):
    client = TestClient(create_app(api_settings, None, sends, cloud_lister=lambda p, k, b: [{"id": "m", "note": "", "free": False}]))
    client.put("/v1/settings/gemini", json={"key": "sk-or-good-key", "provider": "openrouter"}, headers=AUTH)
    assert client.put("/v1/settings/gemini", json={"provider": "custom"}, headers=AUTH).status_code == 400
    unsafe = client.put("/v1/settings/gemini", json={"key": "another-key-1", "provider": "custom", "baseUrl": "http://evil.example/v1"}, headers=AUTH)
    assert unsafe.status_code == 400
    missing = client.put("/v1/settings/gemini", json={"key": "another-key-1", "provider": "custom"}, headers=AUTH)
    assert missing.status_code == 400
    good = client.put("/v1/settings/gemini", json={"key": "another-key-1", "provider": "custom", "baseUrl": "https://x.example/v1/"}, headers=AUTH).json()
    assert good["provider"] == "custom" and good["baseUrl"] == "https://x.example/v1"
