import { formatDate, timeAgo, timeLeft } from './format';
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
