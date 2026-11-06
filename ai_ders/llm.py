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
            "temperature": 0.2,
            "max_tokens": 800,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        if tools:
            body["tools"] = tools
        try:
            response = httpx.post(f"{target}/v1/chat/completions", json=body, timeout=ANSWER_SECONDS)
            response.raise_for_status()
        except httpx.HTTPError as error:
            # The gate may stop the model mid-answer on purpose, when another program needs the GPU.
            raise LlmBusy("model yanıt verirken durdu, biraz sonra tekrar dene") from error
        return response.json()["choices"][0]["message"]


PROVIDER_NAMES = {"gemini": "Gemini", "openrouter": "OpenRouter", "custom": "Bulut model"}
OPENROUTER_URL = "https://openrouter.ai/api/v1"
FREE_PER_MINUTE = 20  # OpenRouter's documented limit for free models; it does not report it per key
# Google publishes no per-model free limits, only a signed-in page per project. These two come from a third-party guide,
# so they are shown as approximate.
GEMINI_APPROX = ((r"3\.8-flash(?!-lite)", "yaklaşık 5 istek/dk, 20/gün"), (r"3\.5-flash-lite", "yaklaşık 10 istek/dk, 500/gün"))
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"
GEMINI_SECONDS = 120.0
DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"


def clean_base_url(url: str) -> str | None:
    """Plain http only to a machine of your own: a key must not cross the internet in the clear."""
    text = url.strip().rstrip("/")
    if re.fullmatch(r"https://[^\s/?#]+(/[^\s?#]*)?", text, re.IGNORECASE):
        return text
    return text if re.fullmatch(r"http://(localhost|127\.|10\.|192\.168\.|100\.)[^\s?#]*", text, re.IGNORECASE) else None


def seen_limit(body: str) -> str | None:
    """What a 429 says about the limit that was hit, such as "20 istek/gün". Google sends it; others may not."""
    value = re.search(r'"quotaValue"\s*:\s*"?(\d+)', body)
    quota = re.search(r'"quotaId"\s*:\s*"([^"]+)"', body)
    if not value or not quota or "request" not in quota.group(1).lower():
        return None
    if "perday" in quota.group(1).lower():
        return f"{value.group(1)} istek/gün"
    return f"{value.group(1)} istek/dk" if "perminute" in quota.group(1).lower() else None


class GeminiClient:
    """Gemini through Google's OpenAI-compatible endpoint. The caller decides whether mail tools go with it."""

    def __init__(self, api_key: str, model: str, client: httpx.Client | None = None, provider: str = "gemini", base_url: str = ""):
        self.api_key = api_key
        self.model = model
        self.client = client or httpx.Client(timeout=GEMINI_SECONDS)
        self.provider = provider
        self.name = PROVIDER_NAMES.get(provider, "Bulut model")
        self.url = {"gemini": GEMINI_URL, "openrouter": f"{OPENROUTER_URL}/chat/completions"}.get(provider, f"{base_url}/chat/completions")

    def chat(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        body: dict[str, Any] = {"model": self.model, "messages": messages, "temperature": 0.4}
        if tools:
            body["tools"] = tools
        if self.provider == "openrouter":
            # A student's text only to providers that do not keep it, and only to those that can really use the tools.
            body["provider"] = {"data_collection": "deny", "require_parameters": True}
        try:
            response = self.client.post(self.url, json=body, headers={"Authorization": f"Bearer {self.api_key}"})
        except httpx.HTTPError as error:
            raise LlmBusy(f"{self.name} servisine ulaşılamıyor") from error
        if response.status_code == 429:
            limit = seen_limit(response.text)
            raise LlmBusy(f"{self.name} kotası doldu{f' (sınır: {limit})' if limit else ''}, biraz sonra tekrar dene")
        if response.status_code in (401, 403):
            raise LlmBusy(f"{self.name} anahtarı geçersiz, Ayarlar'dan yeniden gir")
        if response.status_code == 404:
            raise LlmBusy(f"{self.name}'de {self.model} modeli yok, Ayarlar'dan başka bir model seç")
        if response.status_code != 200:
            raise LlmBusy(f"{self.name} hata verdi ({response.status_code})")
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


def _context(tokens: Any) -> str:
    count = int(tokens or 0)
    if not count:
        return ""
    return f"{round(count / 100_000) / 10:g}M bağlam" if count >= 1_000_000 else f"{round(count / 1000)}K bağlam"


def gemini_options(models: list[dict[str, Any]]) -> list[dict[str, Any]]:
    options: dict[str, dict[str, Any]] = {}
    for model in models:
        name = model.get("name", "").removeprefix("models/")
        if "generateContent" not in (model.get("supportedGenerationMethods") or []):
            continue
        if not re.search(r"flash|pro", name) or re.search(r"tts|image|live|audio|embedding", name):
            continue
        limit = next((text for pattern, text in GEMINI_APPROX if re.search(pattern, name)), "Limit: AI Studio’da")
        options[name] = {"id": name, "note": " · ".join(part for part in (limit, _context(model.get("inputTokenLimit"))) if part), "free": False}
    return sorted(options.values(), key=lambda o: (-_version(o["id"]), "preview" in o["id"], len(o["id"])))


def openrouter_options(models: list[dict[str, Any]], daily: dict[str, Any] | None) -> list[dict[str, Any]]:
    left = f"{daily.get('remaining', '?')}/{daily['limit']} hak kaldı bugün" if daily and daily.get("limit") else "günlük sınır var"
    options = []
    for model in models:
        if not model.get("id"):
            continue
        price = model.get("pricing") or {}
        prompt, completion = float(price.get("prompt", 1) or 0), float(price.get("completion", 1) or 0)
        free = prompt == 0 and completion == 0
        cost = f"Ücretsiz · {FREE_PER_MINUTE} istek/dk, {left}" if free else f"Ücretli · 1M token ${prompt * 1e6:.2f} / ${completion * 1e6:.2f}"
        options.append({"id": model["id"], "note": " · ".join(part for part in (cost, _context(model.get("context_length"))) if part), "free": free})
    return sorted(options, key=lambda o: (not o["free"], o["id"]))


def cloud_models(provider: str, api_key: str, base_url: str = "", client: httpx.Client | None = None) -> list[dict[str, Any]]:
    """The models this key may call, with what is known of their limits. Also how a key is checked before it is kept."""
    client = client or httpx.Client(timeout=20.0)
    name = PROVIDER_NAMES.get(provider, "Bulut model")

    def get(url: str, **params: Any) -> Any:
        try:
            # Google's own list wants its own header and may refuse a bearer key. The others should never see that header.
            headers = {"x-goog-api-key": api_key} if url == GEMINI_MODELS_URL else {"Authorization": f"Bearer {api_key}"}
            response = client.get(url, params=params, headers=headers)
        except httpx.HTTPError as error:
            raise LlmBusy(f"{name} servisine ulaşılamıyor") from error
        if response.status_code in (400, 401, 403):
            raise LlmBusy(f"{name} bu anahtarı kabul etmedi")
        if response.status_code != 200:
            raise LlmBusy(f"{name} hata verdi ({response.status_code})")
        return response.json()

    if provider == "gemini":
        return gemini_options(get(GEMINI_MODELS_URL, pageSize=200).get("models", []))
    if provider == "openrouter":
        # Asked first because the model list alone does not prove that a key works.
        daily = (get(f"{OPENROUTER_URL}/key").get("data") or {}).get("free_model_daily_requests")
        return openrouter_options(get(f"{OPENROUTER_URL}/models", supported_parameters="tools").get("data", []), daily)
    listed = get(f"{base_url}/models").get("data", [])
    return [{"id": m["id"], "note": "Limitler sağlayıcının sayfasında", "free": False} for m in listed if m.get("id")]
