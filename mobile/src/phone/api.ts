/**
 * The phone-only backend, with the same calls the server answers, so every screen works in both modes.
 * Data lives in phone/store.ts, secrets in phone/settings.ts; nothing goes anywhere but Canvas and Google.
 */
import { Linking } from 'react-native';

import type { ChatMessage, ChatSetup, Conversation, Draft, EventItem, EventSource, ItemDetail, TaskOption, Today } from '../types';
import { plainSubject } from '../mailThread';
import { ApiError } from '../types';
import { answer, cloudModel } from './agent';
import { PROVIDER_NAMES } from './cloud';
import { GeminiError } from './gemini';
import { cloudConfig, loadMailSettings, loadPhoneSettings, saveSyllabusCheckDays } from './settings';
import { parseMailHost } from './mail';
import { writeReply } from './reply';
import { recipients, sendMail, SmtpError } from './smtp';
import { suggestTasks } from './suggest';
import { addTask, keepTask, localDay, outdatedTasks, removeTask, updateTask } from './tasks';
import { readState, updateState } from './store';
import { poll } from './watcher';

const UPCOMING_DAYS = 14;
const EVENT_LIMIT = 100;
const STALE_MS = 2 * 60_000; // the Today screen polls Canvas itself when the last round is older than this

function eventSource(itemKey: string): EventSource {
  return itemKey.startsWith('mail:') || itemKey === 'system:mail' ? 'mail' : 'canvas';
}

async function freshState() {
  const state = await readState();
  const last = state.meta.lastPollAt ? Date.parse(state.meta.lastPollAt) : 0;
  if (Date.now() - last < STALE_MS) return state;
  await poll().catch(() => undefined);
  return readState();
}

function mailto(draft: Draft): string {
  const query = `subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
  return `mailto:${encodeURIComponent(draft.to).replace(/%40/g, '@').replace(/%2C/gi, ',')}?${query}`;
}

async function senderOf(): Promise<{ host: string; user: string; password: string; from: string } | null> {
  const [mail, state] = await Promise.all([loadMailSettings(), readState()]);
  const target = parseMailHost(mail.host ?? '');
  if (!target || !mail.password) return null;
  const from = mail.user.includes('@') ? mail.user : state.meta.schoolDomain ? `${mail.user}@${state.meta.schoolDomain}` : '';
  return from ? { host: target.host, user: mail.user, password: mail.password, from } : null;
}

async function approved(draft: Draft) {
  const state = await readState();
  const stored = state.drafts.find((d) => d.id === draft.id && d.status === 'pending');
  if (!stored || stored.to !== draft.to || stored.subject !== draft.subject || stored.body !== draft.body) {
    throw new ApiError('taslak onayladığın halinden farklı', 409);
  }
  return stored;
}

async function openInMailApp(draft: Draft): Promise<{ status: string }> {
  // canOpenURL needs a manifest <queries> entry on Android 11+, so the open itself is the test.
  try {
    await Linking.openURL(mailto(draft));
  } catch {
    throw new ApiError('Telefonda mail uygulaması bulunamadı', 409);
  }
  await updateState((saved) => {
    const row = saved.drafts.find((d) => d.id === draft.id);
    if (row) row.status = 'opened';
  });
  return { status: 'opened' };
}

export const phoneApi = {
  /** True when Canvas is set up: enough for the phone mode to run. Gemini is optional. */
  async configured(): Promise<boolean> {
    const settings = await loadPhoneSettings();
    return !!(settings.canvasUrl && settings.canvasToken);
  },

  async today(): Promise<Today> {
    const state = await freshState();
    const settings = await loadPhoneSettings();
    const now = Date.now();
    const upcoming = Object.values(state.items)
      .filter((i) => i.dueAt && !i.submitted && Date.parse(i.dueAt) >= now && Date.parse(i.dueAt) <= now + UPCOMING_DAYS * 864e5)
      .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))
      .map((i) => ({ key: i.key, kind: i.kind, title: i.title, course: i.course, url: i.url, dueAt: i.dueAt!, inTasks: !!state.meta.gtasks?.[i.key] }));
    const ready = !!settings.geminiKey;
    return {
      upcoming,
      pendingDrafts: state.drafts.filter((d) => d.status === 'pending').length,
      gpu: { mode: 'phone', llmActive: ready, blocked: ready ? null : "Model anahtarı yok, Ayarlar'dan gir" },
      // Without a Google connection a task still goes out through the share sheet.
      tasksEnabled: true,
      tasksOutdated: outdatedTasks(state, localDay(new Date(now).toISOString())),
      exams: Object.entries(state.exams ?? {})
        .filter(([, exam]) => (exam.endsOn ?? exam.startsOn) >= new Date(now).toISOString().slice(0, 10))
        .sort(([, a], [, b]) => a.startsOn.localeCompare(b.startsOn))
        .map(([key, exam]) => ({ ...exam, key, inTasks: !!state.meta.gtasks?.[key] })),
      examsScanning: !state.meta.firstScanDone,
      examsScanProgress: state.meta.firstScanDone ? undefined : state.meta.firstScanProgress,
      examsMissing: Object.values(state.examCourses ?? {})
        // A course with no exam ahead belongs here, or it shows nowhere: a past estimate or a syllabus without dates is no answer.
        .filter((row) => !Object.values(state.exams ?? {}).some((exam) => exam.course === row.course && (exam.endsOn ?? exam.startsOn) >= new Date(now).toISOString().slice(0, 10)))
        .map((row) => ({ course: row.course, hint: row.hint })),
    };
  },

  async events(): Promise<EventItem[]> {
    const state = await readState();
    return [...state.events].reverse().slice(0, EVENT_LIMIT).map((event) => {
      const item = state.items[event.itemKey];
      return {
        ...event,
        // Events from before unread existed count as read.
        read: event.read ?? true,
        source: eventSource(event.itemKey),
        thread: item?.thread,
        hasFiles: !!item?.body?.includes('Ekler (telefonda açılmaz)'),
        fromSchool: !!state.meta.schoolDomain && !!item?.replyTo?.toLowerCase().endsWith(state.meta.schoolDomain.toLowerCase()),
        current: item
          ? { postedAt: item.postedAt, title: item.title, course: item.course, dueAt: item.dueAt, submitted: item.submitted, grade: item.grade }
          : null,
      };
    });
  },

  async refreshEvents(): Promise<{ refreshed: boolean }> {
    const result = await poll();
    return { refreshed: !result.error };
  },

  async syllabusCheck(): Promise<{ days: number }> {
    return { days: (await loadPhoneSettings()).syllabusCheckDays };
  },

  async setSyllabusCheck(days: number): Promise<{ days: number }> {
    await saveSyllabusCheckDays(days);
    return { days };
  },

  async setEventRead(id: number, read: boolean): Promise<{ status: string }> {
    await updateState((state) => {
      const event = state.events.find((other) => other.id === id);
      if (event) event.read = read;
    });
    return { status: read ? 'read' : 'unread' };
  },

  async markAllRead(source: EventSource): Promise<{ status: string }> {
    await updateState((state) => {
      for (const event of state.events) {
        if (eventSource(event.itemKey) === source) event.read = true;
      }
    });
    return { status: 'read' };
  },

  async deleteEvent(id: number): Promise<{ status: string }> {
    await updateState((state) => {
      state.events = state.events.filter((event) => event.id !== id);
    });
    return { status: 'deleted' };
  },

  async item(key: string): Promise<ItemDetail> {
    const state = await readState();
    const row = state.items[key];
    if (!row) throw new ApiError('kayıt bulunamadı', 404);
    return {
      key: row.key, kind: row.kind, title: row.title, course: row.course, sender: row.sender, body: row.body, url: row.url,
      postedAt: row.postedAt, dueAt: row.dueAt, grade: row.grade, submitted: row.submitted, replyTo: row.replyTo, attachments: [], inTasks: !!state.meta.gtasks?.[key],
    };
  },

  async chatSetup(): Promise<ChatSetup> {
    const [state, settings] = await Promise.all([readState(), loadPhoneSettings()]);
    return {
      firstName: state.meta.firstName ?? null,
      models: settings.geminiKey ? [{ id: 'gemini', name: 'Kamil', detail: `${PROVIDER_NAMES[settings.provider]}: ${settings.geminiModel}. Bulutta, bu telefondan.` }] : [],
      schoolDomain: state.meta.schoolDomain ?? '',
      webmailUrl: '',
      features: { localModel: false, gpuGate: false, tasks: true },
    };
  },

  async send(text: string, conversationId: number | null, onStep?: (step: string) => void): Promise<{ reply: string; conversationId: number }> {
    const settings = await loadPhoneSettings();
    const config = cloudConfig(settings);
    if (!config) throw new ApiError("Sohbet için Ayarlar'dan bir model anahtarı gir.", 409);
    try {
      return await answer(cloudModel(config), text, conversationId, onStep);
    } catch (error) {
      throw new ApiError(error instanceof GeminiError || error instanceof Error ? error.message : 'Cevap alınamadı.', 503);
    }
  },

  addTask,
  updateTask,
  keepTask,
  removeTask,

  /** Only when the student taps for it, and it adds nothing. The same rules as chat: mail only if allowed. */
  async suggestTask(key: string): Promise<{ options: TaskOption[] }> {
    const [state, settings, mail] = await Promise.all([readState(), loadPhoneSettings(), loadMailSettings()]);
    const row = state.items[key];
    if (!row) throw new ApiError('kayıt bulunamadı', 404);
    const config = cloudConfig(settings);
    if (!config) throw new ApiError('Model bağlı değil, görevi kendin yazabilirsin', 409);
    if (row.kind === 'mail' && !mail.toGemini) throw new ApiError('Mailler bulut modele kapalı, görevi kendin yazabilirsin', 409);
    try {
      const options = await suggestTasks(cloudModel(config).chat, row, localDay(new Date().toISOString()));
      return { options };
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : 'Öneri alınamadı.', 503);
    }
  },

  /** Written from the whole conversation, addressed from the mail's own headers. It waits in Onaylar. */
  async replyDraft(key: string): Promise<void> {
    const [state, settings, mail] = await Promise.all([readState(), loadPhoneSettings(), loadMailSettings()]);
    const row = state.items[key];
    if (!row || row.kind !== 'mail' || !row.replyTo) throw new ApiError('Bu maile yanıt adresi bulunamadı', 404);
    const config = cloudConfig(settings);
    if (!config) throw new ApiError("Model bağlı değil. Yanıtla ile kendin yazabilirsin.", 409);
    if (!mail.toGemini) throw new ApiError("Mailler bulut modele kapalı. Ayarlar'dan açabilir veya Yanıtla ile kendin yazabilirsin.", 409);
    const thread = Object.values(state.items)
      .filter((item) => item.kind === 'mail' && item.thread && item.thread === row.thread)
      .sort((a, b) => (a.postedAt ?? '').localeCompare(b.postedAt ?? ''));
    let body: string;
    try {
      body = await writeReply(cloudModel(config).chat, thread.length ? thread : [row], state.meta.firstName);
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : 'Taslak yazılamadı.', 503);
    }
    if (!body) throw new ApiError('Model boş yanıt verdi, tekrar dene.', 503);
    const blanks = /\[[^\]\n]{1,80}\]/.test(body);
    await updateState((saved) => {
      saved.drafts.push({
        id: `${Date.now().toString(36)}${Math.floor(Math.random() * 2 ** 32).toString(16)}`,
        to: row.replyTo!.slice(0, 300),
        subject: (/^\s*re\s*:/i.test(row.title) ? row.title : `Re: ${row.title}`).slice(0, 300),
        body,
        createdAt: new Date().toISOString(),
        warnings: blanks ? ['Köşeli parantezli yerleri doldurmadan gönderme: Mail uygulamasında aç ile düzenleyebilirsin.'] : [],
        status: 'pending',
        thread: row.thread,
        inReplyTo: row.messageId || undefined,
        references: row.references || undefined,
      });
    });
  },

  async conversations(): Promise<Conversation[]> {
    const state = await readState();
    const last = new Map<number, number>();
    for (const row of state.chat) last.set(row.conversationId, row.id);
    return [...state.conversations]
      .sort((a, b) => (last.get(b.id) ?? 0) - (last.get(a.id) ?? 0) || b.id - a.id)
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }));
  },

  async conversation(id: number): Promise<{ id: number; title: string; messages: ChatMessage[] }> {
    const state = await readState();
    const row = state.conversations.find((c) => c.id === id);
    if (!row) throw new ApiError('sohbet bulunamadı', 404);
    const messages = state.chat.filter((m) => m.conversationId === id).map((m) => ({ id: m.id, role: m.role, content: m.content }));
    return { id: row.id, title: row.title, messages };
  },

  async deleteConversation(id: number): Promise<{ status: string }> {
    await updateState((state) => {
      state.conversations = state.conversations.filter((c) => c.id !== id);
      state.chat = state.chat.filter((m) => m.conversationId !== id);
    });
    return { status: 'deleted' };
  },

  async deleteAllConversations(): Promise<{ status: string }> {
    await updateState((state) => {
      state.conversations = [];
      state.chat = [];
    });
    return { status: 'deleted' };
  },

  async drafts(): Promise<Draft[]> {
    const state = await readState();
    return state.drafts
      .filter((d) => d.status === 'pending')
      .map((d) => ({ id: d.id, to: d.to, subject: d.subject, body: d.body, hash: d.id, createdAt: d.createdAt, warnings: d.warnings }));
  },

  /** Whether Onaylar can send by itself: a mail account, and an address to send from. */
  async canSendMail(): Promise<boolean> {
    return !!(await senderOf());
  },

  /** Sends with the school account, only ever from the student's tap in Onaylar, and only what they saw. */
  async sendDraft(draft: Draft): Promise<{ status: string }> {
    const stored = await approved(draft);
    const sender = await senderOf();
    if (!sender) return openInMailApp(draft);
    const now = new Date();
    let to: string[];
    let messageId: string;
    try {
      to = recipients(stored.to);
      messageId = await sendMail(sender.host, sender.user, sender.password, {
        from: sender.from, to, subject: stored.subject, body: stored.body, inReplyTo: stored.inReplyTo,
        references: [stored.references, stored.inReplyTo].filter(Boolean).join(' '),
      }, now);
    } catch (error) {
      throw new ApiError(error instanceof SmtpError ? error.message : 'Mail gönderilemedi.', 502);
    }
    await updateState((saved) => {
      const row = saved.drafts.find((d) => d.id === draft.id);
      if (row) row.status = 'sent';
      // It shows in its conversation here. The school's Sent folder does not get a copy: Kamil never writes to the mailbox.
      const key = `mail:sent:${draft.id}`;
      const stamp = now.toISOString();
      saved.items[key] = {
        key, kind: 'mail', title: stored.subject, course: '', url: '', sender: 'Sen', body: stored.body, dueAt: null, postedAt: stamp,
        grade: null, submitted: false, thread: stored.thread ?? `s:${plainSubject(stored.subject)}`, replyTo: to[0], messageId,
        references: stored.references, firstSeen: stamp, lastSeen: stamp,
      };
      saved.events.push({
        id: saved.nextEventId, itemKey: key, type: 'new', level: 'normal', title: `Mail: ${stored.subject}`, body: `Kime: ${stored.to}`, url: '',
        createdAt: stamp, read: true, silent: true,
      });
      saved.nextEventId += 1;
    });
    return { status: 'sent' };
  },

  /** The way out when sending does not work, or the student would rather send it from there. */
  async openDraftInMailApp(draft: Draft): Promise<{ status: string }> {
    await approved(draft);
    return openInMailApp(draft);
  },

  async discardDraft(draft: Draft): Promise<{ status: string }> {
    await updateState((state) => {
      const row = state.drafts.find((d) => d.id === draft.id);
      if (row) row.status = 'discarded';
    });
    return { status: 'discarded' };
  },
};
