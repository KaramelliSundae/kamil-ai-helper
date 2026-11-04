/**
 * The phone backend's state, in one JSON file in the app's private storage (other apps cannot read it).
 * The background task may run in its own JavaScript context, so the file is read fresh for every
 * change; changes within one context are queued so they never interleave.
 */
import { File, Paths } from 'expo-file-system';

import type { EventItem } from '../types';

export type StoredItem = {
  key: string;
  kind: string;
  title: string;
  course: string;
  url: string;
  sender: string;
  body: string;
  dueAt: string | null;
  postedAt: string | null;
  grade: string | null;
  submitted: boolean;
  firstSeen: string;
  lastSeen: string;
};

export type StoredConversation = { id: number; title: string; createdAt: string; updatedAt: string; tainted: boolean };
export type StoredChat = { id: number; conversationId: number; role: 'user' | 'assistant'; content: string; createdAt: string };
export type StoredDraft = {
  id: string;
  to: string;
  subject: string;
  body: string;
  createdAt: string;
  warnings: string[];
  status: 'pending' | 'opened' | 'discarded';
};

export type PhoneState = {
  version: 1;
  items: Record<string, StoredItem>;
  events: EventItem[];
  nextEventId: number;
  conversations: StoredConversation[];
  chat: StoredChat[];
  nextConversationId: number;
  nextChatId: number;
  memories: { text: string; untrusted: boolean; createdAt: string }[];
  drafts: StoredDraft[];
  /** Reminder thresholds already recorded, as "key|dueAt|hours". */
  remindersDone: string[];
  /** Deadline alarms scheduled ahead of time, by notification id. */
  scheduled: string[];
  meta: {
    baselineAt?: string;
    lastPollAt?: string;
    lastError?: string;
    canvasFailures?: number;
    firstName?: string;
    schoolDomain?: string;
    nextReminderId?: number;
  };
};

const FILE_NAME = 'kamil-phone.json';
const EVENT_LIMIT = 300;
const CHAT_LIMIT = 2000;
const CONVERSATION_LIMIT = 100;
const MEMORY_LIMIT = 60;
const OLD_ITEM_DAYS = 120;

function empty(): PhoneState {
  return {
    version: 1,
    items: {},
    events: [],
    nextEventId: 1,
    conversations: [],
    chat: [],
    nextConversationId: 1,
    nextChatId: 1,
    memories: [],
    drafts: [],
    remindersDone: [],
    scheduled: [],
    meta: {},
  };
}

function file(): File {
  return new File(Paths.document, FILE_NAME);
}

export async function readState(): Promise<PhoneState> {
  const target = file();
  if (!target.exists) return empty();
  try {
    const data = JSON.parse(await target.text());
    return { ...empty(), ...data, meta: { ...(data?.meta ?? {}) } };
  } catch {
    return empty(); // a damaged file starts over rather than stopping the app
  }
}

function trim(state: PhoneState, now: number): void {
  state.events = state.events.slice(-EVENT_LIMIT);
  state.conversations = state.conversations.slice(-CONVERSATION_LIMIT);
  const kept = new Set(state.conversations.map((c) => c.id));
  state.chat = state.chat.filter((row) => kept.has(row.conversationId)).slice(-CHAT_LIMIT);
  state.memories = state.memories.slice(-MEMORY_LIMIT);
  state.drafts = state.drafts.filter((d) => d.status === 'pending' || now - Date.parse(d.createdAt) < 30 * 864e5);
  const cutoff = now - OLD_ITEM_DAYS * 864e5;
  for (const [key, item] of Object.entries(state.items)) {
    const due = item.dueAt ? Date.parse(item.dueAt) : 0;
    if (Date.parse(item.lastSeen) < cutoff && due < now) delete state.items[key];
  }
  state.remindersDone = state.remindersDone.slice(-2000);
}

let queue: Promise<unknown> = Promise.resolve();

/** Applies `change` to the stored state and saves it. Changes are queued, so two never interleave. */
export function updateState<T>(change: (state: PhoneState) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const state = await readState();
    const result = await change(state);
    trim(state, Date.now());
    const target = file();
    if (!target.exists) target.create();
    await target.write(JSON.stringify(state));
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Deletes everything this phone stored: items, events, chats, notes and drafts. */
export async function clearState(): Promise<void> {
  await queue.catch(() => undefined);
  const target = file();
  if (target.exists) target.delete();
}
