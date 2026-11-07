/** Mail as conversations: which mails belong together, one row for each, and a reply through the phone's mail app. */
import type { EventItem } from './types';

const REPLY_PREFIX = /^\s*(?:re|fw|fwd|ynt|yan[ıi]t|cvp|cevap|ilt|[iİ]let)\s*(?:\[\d+\])?\s*[:：]\s*/i;
const MAIL_ADDRESS = /^[^\s@<>,;:"?&%]+@[^\s@<>,;:"?&%]+$/;
const LEVELS = ['low', 'normal', 'high', 'critical'];
/** The student's own mail read from the Sent folder. One sent from Kamil has `mail:sent:`. */
export const OUTGOING_KEY = 'mail:out:';

export function isOutgoing(itemKey: string): boolean {
  return itemKey.startsWith(OUTGOING_KEY) || itemKey.startsWith('mail:sent:');
}

/** "Re: Ynt: Vize" is the same conversation as "Vize". */
export function plainSubject(subject: string): string {
  let text = subject;
  while (REPLY_PREFIX.test(text)) text = text.replace(REPLY_PREFIX, '');
  return text.trim().toLocaleLowerCase('tr');
}

/** The first mail of the conversation, as its headers name it. Without any, the subject decides. */
export function threadOf(headers: Record<string, string | undefined>, subject: string): string {
  const ids = (value: string | undefined) => value?.match(/<[^<>\s]+>/g) ?? [];
  return ids(headers.references)[0] ?? ids(headers['in-reply-to'])[0] ?? ids(headers['message-id'])[0] ?? `s:${plainSubject(subject)}`;
}

function subjectOf(event: EventItem): string {
  return event.current?.title ?? event.title.replace(/^[^:]*:\s*/, '');
}

function threadKey(event: EventItem): string {
  return event.thread ?? `s:${plainSubject(subjectOf(event))}`;
}

/**
 * One row for each conversation: its newest event, unread if any of it is, as important as its most important mail. `threadEvents`
 * holds them all, oldest first. Anything that is not a mail stays as it is. `arrived` says when an event came.
 */
export function collapseThreads(events: EventItem[], arrived: (event: EventItem) => number): EventItem[] {
  const groups = new Map<string, EventItem[]>();
  const rows: EventItem[] = [];
  for (const event of events) {
    if (!event.itemKey.startsWith('mail:')) {
      rows.push(event);
      continue;
    }
    const key = threadKey(event);
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }
  // Not every mail program keeps the headers. A "Re:" with the same subject as another conversation is that conversation.
  const bySubject = new Map<string, EventItem[]>();
  for (const [key, group] of groups) {
    const subject = plainSubject(subjectOf(group[0]));
    const other = subject ? bySubject.get(subject) : undefined;
    if (other && group.concat(other).some((event) => REPLY_PREFIX.test(subjectOf(event)))) {
      other.push(...group);
      groups.delete(key);
    } else if (subject && !other) {
      bySubject.set(subject, group);
    }
  }
  for (const group of groups.values()) {
    if (group.every((event) => isOutgoing(event.itemKey))) continue; // nothing came back: not something to read
    const ordered = [...group].sort((a, b) => arrived(a) - arrived(b) || a.id - b.id);
    const newest = ordered[ordered.length - 1];
    rows.push({
      ...newest,
      read: ordered.every((event) => event.read !== false),
      level: ordered.reduce((level, event) => (LEVELS.indexOf(event.level) > LEVELS.indexOf(level) ? event.level : level), newest.level),
      hasFiles: ordered.some((event) => event.hasFiles),
      threadEvents: ordered,
    });
  }
  return rows;
}

/** A reply in the student's own mail app. Only a plain address goes in: a mail cannot add recipients or text this way. */
export function replyLink(to: string | undefined, subject: string, body = ''): string | null {
  if (!to || !MAIL_ADDRESS.test(to.trim())) return null;
  const title = /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
  return `mailto:${to.trim()}?subject=${encodeURIComponent(title)}${body ? `&body=${encodeURIComponent(body)}` : ''}`;
}
