const dateTime = new Intl.DateTimeFormat('tr-TR', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const day = new Intl.DateTimeFormat('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });

const NEAR_EXAM_DAYS = 7;

/** What needs attention first: a known date within a week, then announced dates, then the rest. Soonest first in each. An estimate is only a guess at the week, so it never goes above a known date. */
export function examOrder<T extends { status: string; startsOn: string }>(exams: T[], now: number): T[] {
  const rank = (exam: T) => {
    if (exam.status !== 'estimated' && daysUntil(exam.startsOn, now) <= NEAR_EXAM_DAYS) return 0;
    return exam.status === 'announced' ? 1 : 2;
  };
  return [...exams].sort((a, b) => rank(a) - rank(b) || a.startsOn.localeCompare(b.startsOn));
}

export function formatDate(iso: string): string {
  return dateTime.format(new Date(iso));
}

/** Turkish dative of a name, for "…'e sor": Kamil'e, Gemini'ye. Goes by spelling, not pronunciation. */
export function dative(name: string): string {
  const lower = name.toLocaleLowerCase('tr');
  const vowels = lower.match(/[aeıioöuü]/g);
  const front = 'eiöü'.includes(vowels ? vowels[vowels.length - 1] : 'e');
  return `${name}'${/[aeıioöuü]$/.test(lower) ? 'y' : ''}${front ? 'e' : 'a'}`;
}

/** Mail text with Windows line ends and long runs of blank lines tidied up. */
export function tidyText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function longDate(ms: number): string {
  return day.format(new Date(ms));
}

export function timeLeft(iso: string, now: number): string {
  const minutes = Math.round((new Date(iso).getTime() - now) / 60000);
  if (minutes < 60) return `${Math.max(minutes, 0)} dk kaldı`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} saat kaldı`;
  return `${Math.round(hours / 24)} gün kaldı`;
}

export function timeAgo(iso: string, now: number): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)} dk önce`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} saat önce`;
  return `${Math.round(hours / 24)} gün önce`;
}

export function isSoon(iso: string, now: number): boolean {
  return new Date(iso).getTime() - now < 24 * 3600 * 1000;
}

const shortDate = new Intl.DateTimeFormat('tr-TR', { weekday: 'short', day: 'numeric', month: 'short' });
const dayAndMonth = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' });

const clock = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });

/** "14:05" */
export function clockTime(ms: number): string {
  return clock.format(new Date(ms));
}

/** "14 Kas" */
export function dayMonth(ms: number): string {
  return dayAndMonth.format(new Date(ms));
}

/** "14 Kas Cmt" for a calendar day given as 2026-11-14, or "14 Kas" when `plain`. */
export function shortDay(day: string, plain = false): string {
  const when = new Date(`${day}T12:00:00`);
  return (plain ? dayAndMonth : shortDate).format(when);
}

/** Whole calendar days from `now` to a day given as 2026-11-14: 0 is today, negative has passed. */
export function daysUntil(day: string, now: number): number {
  const start = new Date(now);
  start.setHours(12, 0, 0, 0);
  return Math.round((new Date(`${day}T12:00:00`).getTime() - start.getTime()) / 86400000);
}
