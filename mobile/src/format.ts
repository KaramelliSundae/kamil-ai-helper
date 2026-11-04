const dateTime = new Intl.DateTimeFormat('tr-TR', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const day = new Intl.DateTimeFormat('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });

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

export function isSoon(iso: string, now: number): boolean {
  return new Date(iso).getTime() - now < 24 * 3600 * 1000;
}
