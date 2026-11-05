import { useSyncExternalStore } from 'react';

import { api, ChatMessage, Connection, ModelId } from './api';

/**
 * The open chat, kept outside the screen. Tabs unmount the chat screen, so state held there was lost
 * when the student switched tabs while Kamil was still answering: the question vanished and the answer
 * had nowhere to land. Here the request keeps running, and its answer arrives whichever tab is open.
 */
export type ChatState = {
  conversationId: number | null;
  messages: ChatMessage[];
  model: ModelId;
  /** The model a question is waiting on, or null when nothing is pending. */
  waitingOn: ModelId | null;
  /** What the pending question has gone through so far; the last one is happening now. */
  steps: string[];
  error: string | null;
  /** What is typed in the box but not sent. */
  draft: string;
  /** Changes with every new or opened conversation, so a late answer never lands in the wrong one. */
  view: number;
};

let state: ChatState = {
  conversationId: null,
  messages: [],
  model: 'local',
  waitingOn: null,
  steps: [],
  error: null,
  draft: '',
  view: 0,
};
const listeners = new Set<() => void>();

function update(patch: Partial<ChatState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChat(): ChatState {
  return useSyncExternalStore(subscribe, () => state);
}

function reasonText(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export const chat = {
  setModel(model: ModelId): void {
    update({ model });
  },

  setDraft(draft: string): void {
    if (draft !== state.draft) update({ draft });
  },

  /** A question still waiting finishes on the server and stays in the history; it just is not shown here. */
  startNew(): void {
    update({ conversationId: null, messages: [], error: null, waitingOn: null, steps: [], view: state.view + 1 });
  },

  async open(connection: Connection, id: number): Promise<void> {
    const view = state.view + 1;
    update({ view, error: null, waitingOn: null, steps: [] });
    try {
      const conversation = await api.conversation(connection, id);
      if (state.view === view) update({ conversationId: conversation.id, messages: conversation.messages });
    } catch (reason) {
      if (state.view === view) update({ conversationId: null, messages: [], error: reasonText(reason, 'Sohbet açılamadı.') });
    }
  },

  /** Picks up anything new in the open conversation, unless a question is still on its way. */
  async refresh(connection: Connection): Promise<void> {
    const { conversationId, view } = state;
    if (conversationId === null || state.waitingOn) return;
    try {
      const conversation = await api.conversation(connection, conversationId);
      if (state.view === view && !state.waitingOn) update({ messages: conversation.messages });
    } catch {
      // Keep what is on screen; the next send reports a real problem.
    }
  },

  async send(connection: Connection, raw: string): Promise<void> {
    const question = raw.trim();
    if (!question || state.waitingOn) return;
    const { view, model, conversationId } = state;
    const pending: ChatMessage = { id: -Date.now(), role: 'user', content: question };
    update({ error: null, waitingOn: model, steps: [], draft: '', messages: [...state.messages, pending] });
    try {
      const result = await api.send(connection, question, conversationId, model, (steps) => {
        if (state.view === view && state.waitingOn) update({ steps });
      });
      if (state.view !== view) return; // the student moved on; the answer waits in the history
      const answer: ChatMessage = { id: Date.now(), role: 'assistant', content: result.reply };
      update({ conversationId: result.conversationId, waitingOn: null, steps: [], messages: [...state.messages, answer] });
    } catch (reason) {
      if (state.view !== view) return;
      // The server keeps nothing from a failed turn, so the question goes back in the box to retry.
      update({
        waitingOn: null,
        steps: [],
        messages: state.messages.filter((message) => message !== pending),
        draft: state.draft || question,
        error: reasonText(reason, 'Cevap alınamadı.'),
      });
    }
  },
};
