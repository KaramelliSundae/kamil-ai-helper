"""Model clients. Both speak the OpenAI chat format, so a provider change is a settings change.

`LlmClient` talks to an OpenAI-compatible server on this machine (llama.cpp's llama-server, Ollama,
LM Studio). When a GPU gate is configured it asks the gate first, because the GPU may be lent to
another program for a while and the model stopped meanwhile. `GeminiClient` needs no GPU at all.
"""

from __future__ import annotations

import re
from typing import Any

import httpx

ANSWER_SECONDS = 180.0
ACQUIRE_SECONDS = 60.0


class LlmBusy(Exception):
    """The model cannot answer now. The message says why, and is safe to show the student."""


class LlmClient:
    def __init__(self, url: str, gate_url: str = ""):
        self.url = url.rstrip("/").removesuffix("/v1")
        self.gate_url = gate_url.rstrip("/")

    def chat(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        target = self.url
        if self.gate_url:
            try:
                answer = httpx.post(f"{self.gate_url}/acquire", timeout=ACQUIRE_SECONDS)
            except httpx.HTTPError as error:
                raise LlmBusy("GPU kapısına ulaşılamıyor") from error
            if answer.status_code != 200:
                raise LlmBusy(answer.json().get("reason") or "model şu an kullanılamıyor")
            target = (answer.json().get("url") or target).rstrip("/")
        body = {
            "messages": messages,
            "tools": tools,
            "temperature": 0.2,
            "max_tokens": 800,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        try:
            response = httpx.post(f"{target}/v1/chat/completions", json=body, timeout=ANSWER_SECONDS)
            response.raise_for_status()
        except httpx.HTTPError as error:
            # The gate may stop the model mid-answer on purpose, when another program needs the GPU.
            raise LlmBusy("model yanıt verirken durdu, biraz sonra tekrar dene") from error
        return response.json()["choices"][0]["message"]


GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"
GEMINI_SECONDS = 120.0
DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"


class GeminiClient:
    """Gemini through Google's OpenAI-compatible endpoint. The caller decides whether mail tools go with it."""

    def __init__(self, api_key: str, model: str, client: httpx.Client | None = None):
        self.api_key = api_key
        self.model = model
        self.client = client or httpx.Client(timeout=GEMINI_SECONDS)

    def chat(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        body = {"model": self.model, "messages": messages, "tools": tools, "temperature": 0.4}
        try:
            response = self.client.post(GEMINI_URL, json=body, headers={"Authorization": f"Bearer {self.api_key}"})
        except httpx.HTTPError as error:
            raise LlmBusy("Gemini'ye ulaşılamıyor") from error
        if response.status_code == 429:
            raise LlmBusy("Gemini kotası doldu, biraz sonra tekrar dene")
        if response.status_code in (401, 403):
            raise LlmBusy("Gemini anahtarı geçersiz, Ayarlar'dan yeniden gir")
        if response.status_code == 404:
            raise LlmBusy(f"Gemini'de {self.model} modeli yok, Ayarlar'dan başka bir model seç")
        if response.status_code != 200:
            raise LlmBusy(f"Gemini hata verdi ({response.status_code})")
        return response.json()["choices"][0]["message"]


def _version(name: str) -> float:
    """3.8 for "gemini-3.8-flash-preview-05": the first number is the model's, the rest is a date."""
    found = re.search(r"\d+(?:\.\d+)?", name)
    return float(found.group()) if found else 0.0


def gemini_models(api_key: str, client: httpx.Client | None = None) -> list[str]:
    """The Flash models this key may call, newest first. Also how a key is checked before it is kept."""
    client = client or httpx.Client(timeout=20.0)
    try:
        response = client.get(GEMINI_MODELS_URL, params={"pageSize": 200}, headers={"x-goog-api-key": api_key})
    except httpx.HTTPError as error:
        raise LlmBusy("Gemini'ye ulaşılamıyor") from error
    if response.status_code in (400, 401, 403):
        raise LlmBusy("Gemini bu anahtarı kabul etmedi")
    if response.status_code != 200:
        raise LlmBusy(f"Gemini hata verdi ({response.status_code})")
    names = [
        model.get("name", "").removeprefix("models/")
        for model in response.json().get("models", [])
        if "generateContent" in (model.get("supportedGenerationMethods") or [])
    ]
    flash = [name for name in names if "flash" in name and not re.search(r"tts|image|live|audio|embedding", name)]
    return sorted(set(flash), key=lambda name: (_version(name), "preview" not in name, -len(name)), reverse=True)
