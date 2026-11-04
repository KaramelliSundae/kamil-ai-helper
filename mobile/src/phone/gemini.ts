/**
 * Gemini from the phone, through Google's OpenAI-compatible endpoint. The key goes in a header, never
 * in a URL, so it cannot end up in a log line. Mirrors ai_ders/llm.py.
 */
const CHAT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';
const TIMEOUT_MS = 120_000;

export class GeminiError extends Error {}

export type ChatMessage = { role: string; content: string; tool_calls?: ToolCall[]; tool_call_id?: string };
export type ToolCall = { id?: string; type?: string; function: { name: string; arguments?: string } };

async function call(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new GeminiError("Gemini'ye ulaşılamıyor. İnternet açık mı?");
  } finally {
    clearTimeout(timer);
  }
}

export async function geminiChat(key: string, model: string, messages: ChatMessage[], tools: unknown[]): Promise<ChatMessage> {
  const response = await call(CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, temperature: 0.4 }),
  });
  if (response.status === 429) throw new GeminiError('Gemini kotası doldu, biraz sonra tekrar dene');
  if (response.status === 401 || response.status === 403) throw new GeminiError("Gemini anahtarı geçersiz, Ayarlar'dan yeniden gir");
  if (response.status === 404) throw new GeminiError(`Gemini'de ${model} modeli yok, Ayarlar'dan başka bir model seç`);
  if (!response.ok) throw new GeminiError(`Gemini hata verdi (${response.status})`);
  const body = await response.json();
  const message = body?.choices?.[0]?.message;
  if (!message) throw new GeminiError('Gemini boş cevap döndü');
  return message;
}

function version(name: string): number {
  const found = name.match(/\d+(?:\.\d+)?/);
  return found ? Number(found[0]) : 0;
}

/** The Flash models this key may call, newest first. Also how a key is checked before it is saved. */
export async function geminiModels(key: string): Promise<string[]> {
  const response = await call(MODELS_URL, { headers: { 'x-goog-api-key': key } });
  if ([400, 401, 403].includes(response.status)) throw new GeminiError('Gemini bu anahtarı kabul etmedi');
  if (!response.ok) throw new GeminiError(`Gemini hata verdi (${response.status})`);
  const body = await response.json();
  const names: string[] = (body?.models ?? [])
    .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m: any) => String(m.name ?? '').replace(/^models\//, ''))
    .filter((name: string) => name.includes('flash') && !/tts|image|live|audio|embedding/.test(name));
  return [...new Set(names)].sort(
    (a, b) => version(b) - version(a) || Number(a.includes('preview')) - Number(b.includes('preview')) || a.length - b.length,
  );
}
