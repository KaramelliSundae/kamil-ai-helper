/**
 * The cloud model the phone talks to: Gemini, OpenRouter, or any service with the OpenAI chat format. The key goes in a
 * header, never in a URL, so it cannot end up in a log line. Mirrors ai_ders/llm.py.
 */
import type { ChatMessage } from './gemini';
import { GeminiError, rateLimited, seenLimit } from './gemini';

export type Provider = 'gemini' | 'openrouter' | 'custom';
export type CloudConfig = { provider: Provider; key: string; model: string; baseUrl: string };
export type ModelOption = { id: string; note: string; free: boolean };

export const PROVIDER_NAMES: Record<Provider, string> = { gemini: 'Gemini', openrouter: 'OpenRouter', custom: 'Bulut model' };
export const GEMINI_LIMITS_PAGE = 'https://aistudio.google.com/rate-limit';

const GEMINI_CHAT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODELS = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';
const OPENROUTER = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS = 120_000;
const FREE_PER_MINUTE = 20; // OpenRouter's documented limit for free models; it does not report it per key

// Google publishes no per-model free limits, only a signed-in page per project. These two come from a third-party guide,
// so they are shown as approximate, and whatever Google itself answers with a 429 replaces them.
const GEMINI_APPROX: [RegExp, string][] = [
  [/3\.8-flash(?!-lite)/, 'yaklaşık 5 istek/dk, 20/gün'],
  [/3\.5-flash-lite/, 'yaklaşık 10 istek/dk, 1500/gün'],
];

/** Plain http only to a machine of your own: a key must not cross the internet in the clear. */
export function cleanBaseUrl(url: string): string | null {
  const text = url.trim().replace(/\/+$/, '');
  if (/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(text)) return text;
  return /^http:\/\/(localhost|127\.|10\.|192\.168\.|100\.)[^\s?#]*$/i.test(text) ? text : null;
}

async function call(name: string, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new GeminiError(`${name} servisine ulaşılamıyor. İnternet açık mı?`);
  } finally {
    clearTimeout(timer);
  }
}

export { seenLimit };

/** How many calls a minute to plan for: what the provider told us, else what is known. A wrong guess only means a later 429 waits. */
export function minuteLimit(config: Pick<CloudConfig, 'provider' | 'model'>, seen: Record<string, string> = {}): number {
  const told = seen[config.model]?.match(/(\d+) istek\/dk/)?.[1];
  if (told) return Number(told);
  if (config.provider === 'openrouter') return config.model.endsWith(':free') ? FREE_PER_MINUTE : Number.POSITIVE_INFINITY;
  const approx = config.provider === 'gemini' ? GEMINI_APPROX.find(([pattern]) => pattern.test(config.model))?.[1].match(/(\d+) istek\/dk/)?.[1] : null;
  return approx ? Number(approx) : Number.POSITIVE_INFINITY;
}

export async function cloudChat(config: CloudConfig, messages: ChatMessage[], tools: unknown[], onLimit?: (limit: string) => void): Promise<ChatMessage> {
  const name = PROVIDER_NAMES[config.provider];
  const url = config.provider === 'gemini' ? GEMINI_CHAT : config.provider === 'openrouter' ? `${OPENROUTER}/chat/completions` : `${config.baseUrl}/chat/completions`;
  const body: Record<string, unknown> = { model: config.model, messages, temperature: 0.4 };
  if (tools.length) body.tools = tools;
  // A student's text only to providers that do not keep it, and only to those that can really use the tools.
  if (config.provider === 'openrouter') body.provider = { data_collection: 'deny', require_parameters: true };
  const response = await call(name, url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status === 429) {
    const limited = rateLimited(name, await response.text().catch(() => ''), response.headers?.get?.('retry-after'));
    if (limited.limit) onLimit?.(limited.limit);
    throw limited;
  }
  if (response.status === 401 || response.status === 403) throw new GeminiError(`${name} anahtarı geçersiz, Ayarlar'dan yeniden gir`);
  if (response.status === 404) throw new GeminiError(`${name}: ${config.model} kullanılamıyor. Ayarlar'dan başka bir model seç`);
  if (!response.ok) throw new GeminiError(`${name} hata verdi (${response.status})`);
  const reply = await response.json();
  const message = reply?.choices?.[0]?.message;
  if (!message) throw new GeminiError(`${name} boş cevap döndü`);
  return message;
}

function contextNote(tokens: unknown): string {
  const count = Number(tokens);
  if (!count) return '';
  return count >= 1_000_000 ? `${Math.round(count / 100_000) / 10}M bağlam` : `${Math.round(count / 1000)}K bağlam`;
}

function version(name: string): number {
  const found = name.match(/\d+(?:\.\d+)?/);
  return found ? Number(found[0]) : 0;
}

export function geminiOptions(models: { name?: string; supportedGenerationMethods?: string[]; inputTokenLimit?: number }[], seen: Record<string, string> = {}): ModelOption[] {
  const options = new Map<string, ModelOption>();
  for (const model of models) {
    const id = String(model.name ?? '').replace(/^models\//, '');
    if (!(model.supportedGenerationMethods ?? []).includes('generateContent')) continue;
    if (!id.startsWith('gemini-') || !/flash|pro/.test(id) || /tts|image|live|audio|embedding/.test(id)) continue;
    const limit = seen[id] ? `Sınırın: ${seen[id]}` : GEMINI_APPROX.find(([pattern]) => pattern.test(id))?.[1] ?? 'Limit: AI Studio’da';
    options.set(id, { id, note: [limit, contextNote(model.inputTokenLimit)].filter(Boolean).join(' · '), free: false });
  }
  return [...options.values()].sort(
    (a, b) => version(b.id) - version(a.id) || Number(a.id.includes('preview')) - Number(b.id.includes('preview')) || a.id.length - b.id.length,
  );
}

type OpenRouterModel = { id?: string; context_length?: number; pricing?: { prompt?: string; completion?: string } };

function perMillion(price: string | undefined): string {
  const value = Number(price ?? 0) * 1_000_000;
  return `$${value >= 10 ? value.toFixed(0) : value.toFixed(2)}`;
}

export function openRouterOptions(models: OpenRouterModel[], daily: { remaining?: number; limit?: number } | null): ModelOption[] {
  const left = daily?.limit ? `${daily.remaining ?? '?'}/${daily.limit} hak kaldı bugün` : 'günlük sınır var';
  return models
    .filter((model) => model.id)
    .map((model) => {
      const free = Number(model.pricing?.prompt ?? 1) === 0 && Number(model.pricing?.completion ?? 1) === 0;
      const price = free ? `Ücretsiz · ${FREE_PER_MINUTE} istek/dk, ${left}` : `Ücretli · 1M token ${perMillion(model.pricing?.prompt)} / ${perMillion(model.pricing?.completion)}`;
      return { id: model.id!, note: [price, contextNote(model.context_length)].filter(Boolean).join(' · '), free };
    })
    .sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id));
}

async function json(name: string, url: string, key: string): Promise<any> {
  // Google's own list wants its own header and may refuse a bearer key. The others should never see that header.
  const headers: Record<string, string> = url === GEMINI_MODELS ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` };
  const response = await call(name, url, { headers });
  if ([400, 401, 403].includes(response.status)) throw new GeminiError(`${name} bu anahtarı kabul etmedi`);
  if (!response.ok) throw new GeminiError(`${name} hata verdi (${response.status})`);
  return response.json();
}

/** The models this key may call, with what is known of their limits. Also how a key is checked before it is kept. */
export async function modelOptions(config: Pick<CloudConfig, 'provider' | 'key' | 'baseUrl'>, seen: Record<string, string> = {}): Promise<ModelOption[]> {
  const name = PROVIDER_NAMES[config.provider];
  if (config.provider === 'gemini') {
    return geminiOptions((await json(name, GEMINI_MODELS, config.key))?.models ?? [], seen);
  }
  if (config.provider === 'openrouter') {
    // Asked first because the model list alone does not prove that a key works.
    const key = await json(name, `${OPENROUTER}/key`, config.key);
    const models = await json(name, `${OPENROUTER}/models?supported_parameters=tools`, config.key);
    return openRouterOptions(models?.data ?? [], key?.data?.free_model_daily_requests ?? null);
  }
  const listed = await json(name, `${config.baseUrl}/models`, config.key);
  return (listed?.data ?? [])
    .filter((model: { id?: string }) => model.id)
    .map((model: { id: string }) => ({ id: model.id, note: 'Limitler sağlayıcının sayfasında', free: false }));
}
