/**
 * One polling round on the phone, without any model: the same rules as the server's ai_ders/watcher.py.
 * New and changed Canvas work becomes events (the background task turns them into notifications), and
 * deadline reminders are scheduled ahead of time as alarms, so they arrive even while the app sleeps.
 */
import * as Notifications from 'expo-notifications';

import type { EventItem } from '../types';
import { CanvasAuthError, CanvasItem, fetchCanvas } from './canvas';
import { loadPhoneSettings } from './settings';
import { PhoneState, StoredItem, updateState } from './store';
import { fingerprint, shorten } from './text';

const REMINDER_HOURS = [72, 24, 3];
const CRITICAL_HOURS = 3;
const QUIET_END_HOUR = 8;
const FAILURES_BEFORE_ALERT = 6;
const PREVIEW_CHARS = 280;
const ALARM_DAYS = 30;
const ALARM_PREFIX = 'deadline|';
export const CHANNEL_URGENT = 'urgent';
export const CHANNEL_DEFAULT = 'important';
const KIND_LABELS: Record<string, string> = {
  assignment: 'Yeni ödev',
  quiz: 'Yeni quiz',
  discussion: 'Yeni tartışma',
  event: 'Yeni etkinlik',
  announcement: 'Duyuru',
  message: 'Canvas mesajı',
};

const time = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function formatTime(iso: string): string {
  return time.format(new Date(iso)).replace(',', '');
}

function label(item: { course: string; title: string }): string {
  return item.course ? `${item.course}: ${item.title}` : item.title;
}

function deadlineLevel(due: string | null, now: Date): string {
  if (!due) return 'high';
  const left = Date.parse(due) - now.getTime();
  return left >= 0 && left <= CRITICAL_HOURS * 3600e3 ? 'critical' : 'high';
}

function details(item: CanvasItem): string {
  const parts: string[] = [];
  if (item.dueAt) parts.push(`Son tarih: ${formatTime(item.dueAt)}`);
  if (item.sender) parts.push(`Kimden: ${item.sender}`);
  if (item.body) parts.push(shorten(item.body, PREVIEW_CHARS));
  return parts.join('\n');
}

function addEvent(state: PhoneState, event: Omit<EventItem, 'id'>): void {
  state.events.push({ id: state.nextEventId, ...event });
  state.nextEventId += 1;
}

type Change = { type: 'new' | 'due_changed' | 'graded' | 'updated'; oldDue?: string | null };

function upsert(state: PhoneState, item: CanvasItem, now: string): Change[] {
  const old = state.items[item.key];
  state.items[item.key] = { ...item, firstSeen: old?.firstSeen ?? now, lastSeen: now };
  if (!old) return [{ type: 'new' }];
  const changes: Change[] = [];
  if ((old.dueAt ?? null) !== (item.dueAt ?? null)) changes.push({ type: 'due_changed', oldDue: old.dueAt });
  if (item.grade !== null && old.grade !== item.grade) changes.push({ type: 'graded' });
  if (old.title !== item.title || fingerprint(old.body) !== fingerprint(item.body)) changes.push({ type: 'updated' });
  return changes;
}

function recordChange(state: PhoneState, item: CanvasItem, change: Change, now: Date): void {
  const base = { itemKey: item.key, type: change.type, url: item.url, createdAt: now.toISOString() };
  if (change.type === 'new') {
    addEvent(state, { ...base, level: deadlineLevel(item.dueAt, now), title: `${KIND_LABELS[item.kind] ?? 'Yeni'}: ${label(item)}`, body: details(item) });
  } else if (change.type === 'due_changed') {
    const before = change.oldDue ? formatTime(change.oldDue) : 'yoktu';
    const after = item.dueAt ? formatTime(item.dueAt) : 'kaldırıldı';
    addEvent(state, { ...base, level: deadlineLevel(item.dueAt, now), title: `Tarih değişti: ${label(item)}`, body: `Eski: ${before}\nYeni: ${after}` });
  } else if (change.type === 'graded') {
    addEvent(state, { ...base, level: 'high', title: `Not girildi: ${label(item)}`, body: `Not: ${item.grade}` });
  } else {
    addEvent(state, { ...base, level: 'high', title: `Güncellendi: ${label(item)}`, body: details(item) });
  }
}

function alarmId(item: StoredItem, hours: number): string {
  return `${ALARM_PREFIX}${item.key}|${item.dueAt}|${hours}`;
}

/** One event per item however many thresholds it crossed; silent when an alarm already announced it. */
function addReminders(state: PhoneState, now: Date): void {
  const horizon = now.getTime() + Math.max(...REMINDER_HOURS) * 3600e3;
  const scheduled = new Set(state.scheduled);
  for (const item of Object.values(state.items)) {
    if (!item.dueAt || item.submitted) continue;
    const due = Date.parse(item.dueAt);
    if (due < now.getTime() || due > horizon) continue;
    const crossed = REMINDER_HOURS.filter((h) => now.getTime() >= due - h * 3600e3);
    const pending = crossed.filter((h) => !state.remindersDone.includes(`${item.key}|${item.dueAt}|${h}`));
    if (!pending.length) continue;
    for (const h of pending) state.remindersDone.push(`${item.key}|${item.dueAt}|${h}`);
    const hours = Math.min(...pending);
    addEvent(state, {
      itemKey: item.key,
      type: 'reminder',
      level: hours <= CRITICAL_HOURS ? 'critical' : 'high',
      title: `${hours} saat kaldı: ${label(item)}`,
      body: `Son tarih: ${formatTime(item.dueAt)}`,
      url: item.url,
      createdAt: now.toISOString(),
      silent: scheduled.has(alarmId(item, hours)),
    });
  }
}

/**
 * Keeps one alarm per upcoming threshold: new ones scheduled, moved or handed-in ones cancelled. The
 * 72 and 24 hour alarms wait for the morning when they would fall in the night; the last one never waits.
 */
async function syncAlarms(state: PhoneState, now: Date): Promise<void> {
  const wanted = new Map<string, { at: Date; item: StoredItem; hours: number }>();
  for (const item of Object.values(state.items)) {
    if (!item.dueAt || item.submitted) continue;
    const due = Date.parse(item.dueAt);
    if (due <= now.getTime() || due > now.getTime() + ALARM_DAYS * 864e5) continue;
    for (const hours of REMINDER_HOURS) {
      const at = new Date(due - hours * 3600e3);
      if (hours > CRITICAL_HOURS && at.getHours() < QUIET_END_HOUR) at.setHours(QUIET_END_HOUR, 0, 0, 0);
      if (at.getTime() <= now.getTime() + 60e3 || at.getTime() >= due) continue;
      wanted.set(alarmId(item, hours), { at, item, hours });
    }
  }
  const existing = (await Notifications.getAllScheduledNotificationsAsync())
    .map((request) => request.identifier)
    .filter((id) => id.startsWith(ALARM_PREFIX));
  for (const id of existing) {
    if (!wanted.has(id)) await Notifications.cancelScheduledNotificationAsync(id);
  }
  const have = new Set(existing);
  for (const [id, { at, item, hours }] of wanted) {
    if (have.has(id)) continue;
    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: { title: `${hours} saat kaldı: ${label(item)}`, body: `Son tarih: ${formatTime(item.dueAt!)}`, data: { itemKey: item.key } },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: at,
        channelId: hours <= CRITICAL_HOURS ? CHANNEL_URGENT : CHANNEL_DEFAULT,
      },
    });
  }
  state.scheduled = [...new Set([...state.scheduled.slice(-1500), ...wanted.keys()])];
}

export type PollResult = { items: number; events: number; error: string | null };

/** One round: Canvas, then changes, reminders and alarms. The first round only learns what exists. */
export async function poll(now = new Date()): Promise<PollResult> {
  const settings = await loadPhoneSettings();
  if (!settings.canvasUrl || !settings.canvasToken) return { items: 0, events: 0, error: 'Canvas ayarlı değil' };
  let items: CanvasItem[] = [];
  let failure: unknown = null;
  try {
    items = await fetchCanvas({ url: settings.canvasUrl, token: settings.canvasToken }, now);
  } catch (error) {
    failure = error;
  }
  return updateState(async (state) => {
    const before = state.events.length;
    const stamp = now.toISOString();
    if (failure) {
      const message = failure instanceof Error ? failure.message : 'Canvas okunamadı';
      const failures = (state.meta.canvasFailures ?? 0) + 1;
      state.meta.canvasFailures = failures;
      state.meta.lastError = message;
      // A refused token is reported at once; an outage only after an hour of failed rounds.
      if (failures === FAILURES_BEFORE_ALERT || (failure instanceof CanvasAuthError && failures === 1)) {
        addEvent(state, { itemKey: 'system:canvas', type: 'alert', level: 'critical', title: 'Canvas takibi çalışmıyor', body: message, url: '', createdAt: stamp });
      }
    } else {
      const baseline = !state.meta.baselineAt;
      for (const item of items) {
        for (const change of upsert(state, item, stamp)) {
          if (!baseline) recordChange(state, item, change, now);
        }
      }
      state.meta.baselineAt ??= stamp;
      state.meta.canvasFailures = 0;
      state.meta.lastError = undefined;
    }
    addReminders(state, now);
    await syncAlarms(state, now).catch(() => undefined); // alarms are a bonus; events still record everything
    state.meta.lastPollAt = stamp;
    return {
      items: items.length,
      events: state.events.length - before,
      error: failure ? state.meta.lastError ?? 'Canvas okunamadı' : null,
    };
  });
}
