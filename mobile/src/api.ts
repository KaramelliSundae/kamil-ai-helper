import * as SecureStore from 'expo-secure-store';

import { phoneApi } from './phone/api';
import type {
  ChatMessage,
  ChatSetup,
  Conversation,
  Draft,
  EventItem,
  EventSource,
  GeminiSettings,
  GpuState,
  ItemDetail,
  ModelId,
  Release,
  Today,
} from './types';
import { ApiError } from './types';

export * from './types';

const MODE_KEY = 'mode';
const SERVER_KEY = 'server';
const TOKEN_KEY = 'token';
const STEP_POLL_MS = 800;
const REQUEST_MS = 200_000; // a local model may need time to load and answer

/**
 * Where the app's data comes from: your own server (always on, reads school mail in a sandbox), or this
 * phone alone (Canvas and Gemini straight from the phone, no server at all).
 */
export type ServerConnection = { mode: 'server'; server: string; token: string };
export type PhoneConnection = { mode: 'phone' };
export type Connection = ServerConnection | PhoneConnection;

export async function loadConnection(): Promise<Connection | null> {
  const mode = await SecureStore.getItemAsync(MODE_KEY);
  if (mode === 'phone') return (await phoneApi.configured()) ? { mode: 'phone' } : null;
  const [server, token] = await Promise.all([SecureStore.getItemAsync(SERVER_KEY), SecureStore.getItemAsync(TOKEN_KEY)]);
  // Installs from before the phone mode stored no mode: a saved server means server mode.
  return server && token ? { mode: 'server', server, token } : null;
}

export async function saveConnection(connection: Connection): Promise<void> {
  await SecureStore.setItemAsync(MODE_KEY, connection.mode);
  if (connection.mode === 'server') {
    await SecureStore.setItemAsync(SERVER_KEY, connection.server);
    await SecureStore.setItemAsync(TOKEN_KEY, connection.token);
  }
}

export function serverUrl(connection: ServerConnection): string {
  return connection.server.replace(/\/+$/, '');
}

async function request<T>(connection: ServerConnection, path: string, method: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_MS);
  let response: Response;
  try {
    response = await fetch(`${serverUrl(connection)}${path}`, {
      method,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Sunucuya ulaşılamıyor. Aynı ağda mısın, ya da Tailscale açık mı?', 0);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401) {
    throw new ApiError('Token geçersiz. Ayarlar ekranından kontrol et.', 401);
  }
  if (!response.ok) {
    const detail = await response.json().then((data) => data?.detail, () => null);
    throw new ApiError(typeof detail === 'string' ? detail : `Sunucu hatası (${response.status})`, response.status);
  }
  return response.json();
}

/** Every call goes to the server or to the phone backend, depending on the connection. */
export const api = {
  today: (c: Connection) => (c.mode === 'phone' ? phoneApi.today() : request<Today>(c, '/v1/today', 'GET')),
  events: (c: Connection) => (c.mode === 'phone' ? phoneApi.events() : request<EventItem[]>(c, '/v1/events', 'GET')),
  /** Asks for a fresh look at Canvas and mail now; the list is then read with `events`. */
  refreshEvents: (c: Connection) =>
    c.mode === 'phone' ? phoneApi.refreshEvents() : request<{ refreshed: boolean }>(c, '/v1/events/refresh', 'POST'),
  syllabusCheck: (c: Connection) =>
    c.mode === 'phone' ? phoneApi.syllabusCheck() : request<{ days: number }>(c, '/v1/settings/syllabus-check', 'GET'),
  setSyllabusCheck: (c: Connection, days: number) =>
    c.mode === 'phone' ? phoneApi.setSyllabusCheck(days) : request<{ days: number }>(c, '/v1/settings/syllabus-check', 'POST', { days }),
  setEventRead: (c: Connection, id: number, read: boolean) =>
    c.mode === 'phone' ? phoneApi.setEventRead(id, read) : request<{ status: string }>(c, `/v1/events/${id}/read`, 'POST', { read }),
  markAllRead: (c: Connection, source: EventSource) =>
    c.mode === 'phone' ? phoneApi.markAllRead(source) : request<{ status: string }>(c, '/v1/events/read-all', 'POST', { source }),
  deleteEvent: (c: Connection, id: number) =>
    c.mode === 'phone' ? phoneApi.deleteEvent(id) : request<{ status: string }>(c, `/v1/events/${id}`, 'DELETE'),
  send: (c: Connection, text: string, conversationId: number | null, model: ModelId, onSteps?: (steps: string[]) => void) => {
    if (c.mode === 'phone') {
      const steps: string[] = [];
      return phoneApi.send(text, conversationId, (step) => {
        if (steps[steps.length - 1] !== step) steps.push(step);
        onSteps?.([...steps]);
      });
    }
    // The answer is one long request, so the steps are asked for beside it. Missing steps never hurt the answer.
    const turnId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let asking = false;
    const ticker = setInterval(() => {
      if (asking || !onSteps) return;
      asking = true;
      request<{ steps: string[] }>(c, `/v1/chat/progress/${turnId}`, 'GET')
        .then(({ steps }) => onSteps(steps), () => undefined)
        .finally(() => { asking = false; });
    }, STEP_POLL_MS);
    return request<{ reply: string; conversationId: number }>(c, '/v1/chat', 'POST', {
      text,
      conversationId,
      new: conversationId === null,
      model,
      turnId,
    }).finally(() => clearInterval(ticker));
  },
  chatSetup: (c: Connection) => (c.mode === 'phone' ? phoneApi.chatSetup() : request<ChatSetup>(c, '/v1/chat/setup', 'GET')),
  conversations: (c: Connection) =>
    c.mode === 'phone' ? phoneApi.conversations() : request<Conversation[]>(c, '/v1/conversations', 'GET'),
  conversation: (c: Connection, id: number) =>
    c.mode === 'phone'
      ? phoneApi.conversation(id)
      : request<{ id: number; title: string; messages: ChatMessage[] }>(c, `/v1/conversations/${id}`, 'GET'),
  deleteConversation: (c: Connection, id: number) =>
    c.mode === 'phone' ? phoneApi.deleteConversation(id) : request<{ status: string }>(c, `/v1/conversations/${id}`, 'DELETE'),
  deleteAllConversations: (c: Connection) =>
    c.mode === 'phone' ? phoneApi.deleteAllConversations() : request<{ status: string }>(c, '/v1/conversations', 'DELETE'),
  item: (c: Connection, key: string) =>
    c.mode === 'phone' ? phoneApi.item(key) : request<ItemDetail>(c, `/v1/items/${encodeURIComponent(key)}`, 'GET'),
  addTask: (c: Connection, key: string) =>
    c.mode === 'phone'
      ? Promise.reject(new ApiError('Google Tasks yalnızca sunucuyla çalışır', 409))
      : request<{ status: string }>(c, '/v1/tasks', 'POST', { key }),
  removeTask: (c: Connection, key: string) =>
    c.mode === 'phone'
      ? Promise.reject(new ApiError('Google Tasks yalnızca sunucuyla çalışır', 409))
      : request<{ status: string }>(c, '/v1/tasks/remove', 'POST', { key }),
  drafts: (c: Connection) => (c.mode === 'phone' ? phoneApi.drafts() : request<Draft[]>(c, '/v1/drafts', 'GET')),
  sendDraft: (c: Connection, draft: Draft) =>
    c.mode === 'phone'
      ? phoneApi.sendDraft(draft)
      : request<{ status: string }>(c, `/v1/drafts/${draft.id}/send`, 'POST', { hash: draft.hash }),
  discardDraft: (c: Connection, draft: Draft) =>
    c.mode === 'phone'
      ? phoneApi.discardDraft(draft)
      : request<{ status: string }>(c, `/v1/drafts/${draft.id}/discard`, 'POST'),
  gpu: (c: Connection) =>
    c.mode === 'phone' ? Promise.reject(new ApiError('GPU yok', 404)) : request<GpuState>(c, '/v1/gpu', 'GET'),
  setGpuMode: (c: Connection, mode: string) =>
    c.mode === 'phone' ? Promise.reject(new ApiError('GPU yok', 404)) : request<GpuState>(c, '/v1/gpu', 'POST', { mode }),
  setKamilPriority: (c: ServerConnection, on: boolean) => request<GpuState>(c, '/v1/gpu/priority', 'POST', { on }),
  latestApp: (c: Connection) =>
    c.mode === 'phone' ? Promise.reject(new ApiError('sunucu yok', 404)) : request<Release>(c, '/v1/app/latest', 'GET'),
  // Gemini on a server: the key is checked by the server with Google and kept there.
  geminiSettings: (c: ServerConnection) => request<GeminiSettings>(c, '/v1/settings/gemini', 'GET'),
  setGeminiSettings: (c: ServerConnection, change: { key?: string; model?: string; mailAllowed?: boolean }) =>
    request<GeminiSettings>(c, '/v1/settings/gemini', 'PUT', change),
  deleteGeminiKey: (c: ServerConnection) => request<GeminiSettings>(c, '/v1/settings/gemini', 'DELETE'),
  geminiModels: (c: ServerConnection) => request<string[]>(c, '/v1/settings/gemini/models', 'GET'),
};
