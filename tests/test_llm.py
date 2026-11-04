from __future__ import annotations

import json

import httpx
import pytest

from ai_ders.llm import GEMINI_URL, GeminiClient, LlmBusy


def gemini(handler) -> GeminiClient:
    return GeminiClient("key", "gemini-test-flash", httpx.Client(transport=httpx.MockTransport(handler)))


def test_gemini_gets_the_model_tools_and_key():
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == GEMINI_URL and request.headers["Authorization"] == "Bearer key"
        body = json.loads(request.content)
        assert body["model"] == "gemini-test-flash" and body["tools"] == [{"type": "function"}]
        return httpx.Response(200, json={"choices": [{"message": {"content": "Merhaba"}}]})

    assert gemini(handler).chat([{"role": "user", "content": "Selam"}], [{"type": "function"}]) == {"content": "Merhaba"}


@pytest.mark.parametrize(("status", "words"), [(429, "kota"), (401, "anahtar"), (500, "500")])
def test_gemini_failures_are_readable(status, words):
    with pytest.raises(LlmBusy, match=words):
        gemini(lambda request: httpx.Response(status, json={})).chat([], [])


def test_the_model_list_offers_flash_models_newest_first():
    from ai_ders.llm import gemini_models

    def handler(request):
        assert request.headers["x-goog-api-key"] == "key" and "key=" not in str(request.url)  # never in the URL
        names = ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.8-pro", "gemini-3.8-flash-tts", "gemini-3.8-flash-preview-05"]
        models = [{"name": f"models/{n}", "supportedGenerationMethods": ["generateContent"]} for n in names]
        models.append({"name": "models/text-embedding-9", "supportedGenerationMethods": ["embedContent"]})
        return httpx.Response(200, json={"models": models})

    listed = gemini_models("key", httpx.Client(transport=httpx.MockTransport(handler)))
    assert listed == ["gemini-3.8-flash", "gemini-3.8-flash-preview-05", "gemini-3.5-flash"]


def test_a_refused_key_is_reported_plainly():
    from ai_ders.llm import gemini_models

    client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(400, json={"error": {}})))
    with pytest.raises(LlmBusy, match="kabul etmedi"):
        gemini_models("bad", client)
