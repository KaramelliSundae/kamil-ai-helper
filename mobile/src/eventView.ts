import { clockTime, dayMonth, formatDate, timeAgo, timeLeft } from './format';
import type { EventItem } from './types';

export type EventView = {
  title: string;
  body: string;
  /** What holds now, such as "3 saat kaldı" or "Teslim edildi". */
  status: string | null;
  /** The deadline is near and the work is not done. */
  urgent: boolean;
  /** Nothing left to act on, so the row should not look alarming. */
  over: boolean;
};

const FROZEN_COUNTDOWN = /^\d+ saat kaldı: /;
const DUE_LINE = /^Son tarih: .*(\n|$)/m;

/** An event records what happened at the time; this says what is true now, from its item as it is now. */
export function eventView(event: EventItem, now: number): EventView {
  const item = event.current;
  const name = item ? (item.course ? `${item.course}: ${item.title}` : item.title) : null;
  const title = event.type === 'reminder' ? (name ?? event.title.replace(FROZEN_COUNTDOWN, '')) : event.title;
  if (!item) return { title, body: event.body, status: null, urgent: false, over: false };

  const body = item.dueAt
    ? event.body.replace(DUE_LINE, (_line, end: string) => `Son tarih: ${formatDate(item.dueAt!)}${end}`)
    : event.body.replace(DUE_LINE, '');
  const dueMs = item.dueAt ? Date.parse(item.dueAt) : null;
  if (item.grade) {
    const status = `Not: ${item.grade}`;
    return { title, body: body.trim() === status ? '' : body, status, urgent: false, over: true };
  }
  if (item.submitted) return { title, body, status: 'Teslim edildi', urgent: false, over: true };
  if (dueMs === null) return { title, body, status: null, urgent: false, over: false };
  if (dueMs <= now) return { title, body, status: `Süresi geçti, ${timeAgo(item.dueAt!, now)}`, urgent: false, over: true };
  return { title, body, status: timeLeft(item.dueAt!, now), urgent: dueMs - now < 24 * 3600e3, over: false };
}

export type EventRow = EventView & {
  /** Whose it is: the course, or who sent the mail. */
  label: string;
  /** The thing itself, without the words the label and the icon already say. */
  headline: string;
  preview: string;
};

const SENDER_LINE = /^Kimden: (.*)(\n|$)/m;
// Worth saying in words. "Duyuru" and "Mail" are not: the icon and the list say those.
const CHANGE = /^(Yeni [^:]+|Tarih değişti|Not girildi|Güncellendi): /;

function senderName(line: string): string {
  return line.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || line.trim();
}

/** What a row of the list shows, cut down so that it can say more in less space. */
export function eventRow(event: EventItem, now: number): EventRow {
  const view = eventView(event, now);
  const sender = view.body.match(SENDER_LINE)?.[1] ?? '';
  const text = view.body.replace(SENDER_LINE, '').replace(/^(Son tarih: .*)\n/m, '$1 · ').replace(/\s+/g, ' ').trim();
  const change = event.title.match(CHANGE)?.[1];
  const preview = change && text ? `${change} · ${text}` : change ?? text;
  const item = event.current;
  if (item) return { ...view, label: item.course || senderName(sender), headline: item.title, preview };
  // Nothing behind it to ask, so the title is all there is: "Course: Vize duyuruldu".
  const colon = event.type === 'exam' ? view.title.indexOf(': ') : -1;
  return colon > 0
    ? { ...view, label: view.title.slice(0, colon), headline: view.title.slice(colon + 2), preview }
    : { ...view, label: senderName(sender) || 'Kamil', headline: view.title, preview };
}

/** When it really arrived. New mail and announcements carry their own time; the watcher only saw them some minutes later. */
export function arrivedAt(event: EventItem): number {
  const posted = event.type === 'new' ? event.current?.postedAt : null;
  return Date.parse(posted ?? event.createdAt) || 0;
}

function daysAgo(ms: number, now: number): number {
  const start = (time: number) => new Date(time).setHours(12, 0, 0, 0);
  return Math.round((start(now) - start(ms)) / 864e5);
}

export function dayGroup(ms: number, now: number): string {
  const days = daysAgo(ms, now);
  if (days <= 0) return 'Bugün';
  if (days === 1) return 'Dün';
  return days < 7 ? 'Bu hafta' : 'Daha eski';
}

/** The time when the day is already plain from the group above it, otherwise the date. */
export function rowTime(ms: number, now: number): string {
  return daysAgo(ms, now) <= 1 ? clockTime(ms) : dayMonth(ms);
}

export type ListEntry =
  | { kind: 'head'; key: string; label: string }
  | { kind: 'row'; key: string; event: EventItem; first: boolean; last: boolean };

/** A list already sorted newest first, with a heading before each group of days. */
export function groupByDay(events: EventItem[], now: number): ListEntry[] {
  const groups = events.map((event) => dayGroup(arrivedAt(event), now));
  const entries: ListEntry[] = [];
  events.forEach((event, index) => {
    const first = groups[index] !== groups[index - 1];
    if (first) entries.push({ kind: 'head', key: `head-${groups[index]}`, label: groups[index] });
    entries.push({ kind: 'row', key: String(event.id), event, first, last: groups[index] !== groups[index + 1] });
  });
  return entries;
}
