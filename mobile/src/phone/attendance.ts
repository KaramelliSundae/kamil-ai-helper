/**
 * Finding what attendance a course asks for, the same way as ai_ders/attendance.py. Schools rarely give it for every course, so
 * this only collects the sentences that exist. Kamil reads them when the student asks; they are other people's text.
 */
export type AttendanceNote = { source: string; text: string };

export const MAX_ATTENDANCE_NOTES = 6;
const NOTE_CHARS = 280;
const ATTENDANCE =
  /attendance|\battend(?:ing)?\b|absen(?:ce|ces|t|teeism)\b|\bmiss(?:es|ing)?\b[^.]{0,40}\b(?:class|lecture|session)|devams[ıi]z|yoklama|devam\s*(?:zorunlu|mecburi|[şs]art|ko[şs]ul|y[üu]k[üu]ml[üu]|oran|durum)|ders(?:e|lere|lerin|in)\s+(?:\S+\s+){0,3}devam|(?:%\s*\d+|\d+\s*%|y[üu]zde\s*\d+)\S*\s+(?:\S+\s+){0,2}devam|ders(?:e|lere)\s+kat[ıi]l[ıi]m|kat[ıi]l[ıi]m\s*zorunlu/i;
const FIGURE = /%\s*\d|\d\s*%|y[üu]zde\s*\d|percent|\d+\s*(?:hafta|week|ders\b|class|saat|hour|lecture|session|kez|times)/i;
// A sentence that only mentions attending says nothing: it needs a figure or a duty.
const DUTY = /zorunlu|mecburi|[şs]art|mandatory|compulsory|required|obligatory|\bmust\b|\bf[xzf]\b|\bdz\b|kal[ıi]r|ba[şs]ar[ıi]s[ıi]z|\bfail|will be taken|al[ıi]n[ıi]r|al[ıi]nacak/i;

/** The sentences that say something about attendance, those with a figure first. */
export function findAttendance(text: string): string[] {
  const notes: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    for (const sentence of paragraph.trim().split(/\s+/).join(' ').split(/(?<=[.!?;])\s+/)) {
      const match = ATTENDANCE.exec(sentence);
      if (match && (FIGURE.test(sentence) || DUTY.test(sentence))) {
        const start = Math.max(0, match.index - Math.floor(NOTE_CHARS / 2));
        notes.push(sentence.slice(start, start + NOTE_CHARS));
      }
    }
  }
  const unique = [...new Set(notes)];
  return [...unique.filter((note) => FIGURE.test(note)), ...unique.filter((note) => !FIGURE.test(note))].slice(0, MAX_ATTENDANCE_NOTES);
}
