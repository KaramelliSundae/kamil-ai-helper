/**
 * Finding midterm and final dates on the phone: the same rules as the server's ai_ders/exams.py. An announced date beats a date in a
 * syllabus, which beats a week. Everything read here is someone else's text, and is only ever searched for dates.
 *
 * With no sandbox here, PDF files go to Gemini when there is a key and syllabus reading is on: each file is one request, so the
 * student chooses how often. Its answer is searched the same way, so nothing in a file can tell the app to do anything.
 */
import { File, Paths } from 'expo-file-system';

import { AttendanceNote, findAttendance, MAX_ATTENDANCE_NOTES } from './attendance';
import { courseFile, courseFiles, courseInfo, CanvasItem, frontPage, moduleItems } from './canvas';
import { minuteLimit } from './cloud';
import { geminiReadPdf, RateLimited } from './gemini';
import { queued } from './modelQueue';
import { readState } from './store';
import { htmlToText } from './text';

export type ExamStatus = 'announced' | 'syllabus' | 'estimated';
export type FoundExam = {
  kind: 'midterm' | 'final';
  number: number;
  startsOn: string;
  endsOn: string | null;
  status: ExamStatus;
  week: number | null;
  source: string;
  evidence: string;
  url: string;
};

export const TRUST: Record<ExamStatus, number> = { estimated: 1, syllabus: 2, announced: 3 };
const MIN_SYLLABUS_CHARS = 200;
const MAX_EVIDENCE_CHARS = 160;
const MAX_FILES_PER_COURSE = 2;
const MAX_LINKS_PER_COURSE = 2;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const EARLIEST_DAYS = 240;
const LATEST_DAYS = 400;
const MAX_WEEK = 18;
const DAY_MS = 86400000;

const MIDTERM = 'mid[\\s-]?terms?(?:\\s+exams?)?|ara\\s*s[ıi]nav(?:[ıi])?|vize(?:\\s*s[ıi]nav[ıi])?|vizesi';
const FINAL = 'finals?(?:\\s+exams?)?|final\\s*s[ıi]nav[ıi]|finali|y[ıa]r[ıi]y[ıi]l\\s*sonu(?:\\s*s[ıi]nav[ıi])?|d[öo]nem\\s*sonu(?:\\s*s[ıi]nav[ıi])?';
const WORD = 'a-zA-Z0-9_çğıöşüÇĞİÖŞÜ';
const keyword = () => new RegExp(`(?<![${WORD}])(?:(${MIDTERM})|(${FINAL}))(?![${WORD}])`, 'gi');
const NOT_A_DATE = /sonu[çc]|result|grade|graded|notu|notlar|weight|%|y[üu]zde|percent|proje|project|report|rapor|paper|essay|presentation|sunum|[öo]dev|homework|assignment|submission|submit|teslim|deliverable|draft|b[üu]t[üu]nleme|makeup|make-up|mazeret|review session|tekrar dersi/i;

const MONTHS: Record<string, number> = {
  ocak: 1, şubat: 2, subat: 2, mart: 3, nisan: 4, mayıs: 5, mayis: 5, haziran: 6, temmuz: 7, ağustos: 8, agustos: 8, eylül: 9,
  eylul: 9, ekim: 10, kasım: 11, kasim: 11, aralık: 12, aralik: 12, january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const END_WORD = `(?![${WORD}])`;
const dayMonth = () => new RegExp(`(?<![\\d.])(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})${END_WORD}\\.?(?:,?\\s*(\\d{4}))?`, 'gi');
const monthDay = () => new RegExp(`(?<![${WORD}])(${MONTH})${END_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])(?:,?\\s*(\\d{4}))?`, 'gi');
const numericYear = () => /(?<![\d.])(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/g;
const numericShort = () => /(?<![\d.:])(\d{1,2})[./](\d{1,2})(?![\d:.%])/g;
const CLOCK_BEFORE = /(saat|at|time)\s*$/i;
const WEEK_AFTER = /(?<![a-zA-Z])(?:week|wk|hafta)s?\s*[:#.]?\s*(\d{1,2})(?:\s*(?:-|–|—|and|ve|&|,)\s*(\d{1,2}))?/i;
const WEEK_BEFORE = /(?<![\d.])(\d{1,2})(?:\s*(?:-|–|—)\s*(\d{1,2}))?(?:st|nd|rd|th|\.)?\s*(?:week|hafta)/i;
const TABLE_ROW = /^\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*[.):|\-–]?\s*$/i;
const PLAUSIBLE_ROW_WEEKS = { midterm: [4, 12], final: [10, 18] };
const NUMBER_AFTER = /^\s*[-#]?\s*([1-3]|ii|i)(?![a-zA-Z0-9])(?!\.?\s*(?:hafta|week))/i;
const NUMBER_BEFORE = /(?:([1-3])\s*(?:st|nd|rd|\.)|(birinci|first|ikinci|second))\s*$/i;
const LONG_LIST_ITEM = 40;
const FILE_LINK = /\/files\/(\d+)/g;
const MAX_LINKED_FILES = 10;
const SYLLABUS_WORDS = /syllabus|izlence|outline|course\s*(?:info|plan|description)|ders\s*(?:bilgi|plan|tan[ıi]t)/i;
const FILE_SEARCHES = ['syllabus', 'izlence', 'outline', 'course', 'ders'];
const LINK = /https:\/\/[^\s"'<>)\]]+/g;

function iso(when: Date): string {
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
}

function local(year: number, month: number, day: number): Date | null {
  const when = new Date(year, month - 1, day);
  return when.getMonth() === month - 1 && when.getDate() === day ? when : null;
}

function withYear(month: number, day: number, year: number | null, today: Date): Date | null {
  const days = (when: Date) => (when.getTime() - today.getTime()) / DAY_MS;
  let when: Date | null;
  if (year !== null) {
    when = local(year < 100 ? year + 2000 : year, month, day);
  } else {
    when = local(today.getFullYear(), month, day);
    if (when && days(when) < -EARLIEST_DAYS) when = local(today.getFullYear() + 1, month, day);
    else if (when && days(when) > LATEST_DAYS - 100) when = local(today.getFullYear() - 1, month, day);
  }
  return when && days(when) >= -EARLIEST_DAYS && days(when) <= LATEST_DAYS ? when : null;
}

export function findDate(text: string, today: Date): Date | null {
  for (const m of text.matchAll(dayMonth())) {
    const when = withYear(MONTHS[m[2].toLocaleLowerCase('tr')] ?? MONTHS[m[2].toLowerCase()], Number(m[1]), m[3] ? Number(m[3]) : null, today);
    if (when) return when;
  }
  for (const m of text.matchAll(monthDay())) {
    const when = withYear(MONTHS[m[1].toLocaleLowerCase('tr')] ?? MONTHS[m[1].toLowerCase()], Number(m[2]), m[3] ? Number(m[3]) : null, today);
    if (when) return when;
  }
  for (const m of text.matchAll(numericYear())) {
    const when = withYear(Number(m[2]), Number(m[1]), Number(m[3]), today);
    if (when) return when;
  }
  for (const m of text.matchAll(numericShort())) {
    if (CLOCK_BEFORE.test(text.slice(0, m.index))) continue;
    const when = withYear(Number(m[2]), Number(m[1]), null, today);
    if (when) return when;
  }
  return null;
}

function findWeek(text: string): [number, number] | null {
  for (const pattern of [WEEK_AFTER, WEEK_BEFORE]) {
    const m = text.match(pattern);
    if (m) {
      const first = Number(m[1]);
      const last = Number(m[2] ?? m[1]);
      if (first >= 1 && first <= last && last <= MAX_WEEK) return [first, last];
    }
  }
  return null;
}

function examNumber(text: string, start: number, end: number): number {
  const after = text.slice(end).match(NUMBER_AFTER);
  if (after) {
    const word = after[1].toLowerCase();
    return word === 'i' ? 1 : word === 'ii' ? 2 : Number(after[1]);
  }
  const before = text.slice(0, start).match(NUMBER_BEFORE);
  if (before) {
    if (before[1]) return !text.slice(0, before.index).trim() && text.length >= LONG_LIST_ITEM ? 0 : Number(before[1]);
    return ['birinci', 'first'].includes(before[2].toLowerCase()) ? 1 : 2;
  }
  return 0;
}

export function termStartGuess(today: Date): Date {
  const month = today.getMonth() + 1;
  const start = month >= 8 ? new Date(today.getFullYear(), 8, 22) : month === 1 ? new Date(today.getFullYear() - 1, 8, 22) : new Date(today.getFullYear(), 1, 16);
  return monday(start);
}

function monday(when: Date): Date {
  return new Date(when.getFullYear(), when.getMonth(), when.getDate() - ((when.getDay() + 6) % 7));
}

function addDays(when: Date, days: number): Date {
  return new Date(when.getFullYear(), when.getMonth(), when.getDate() + days);
}

function chunksOf(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => line.split(/(?<=[!?;])\s+|(?<=[a-zçğıöşü)]\.)\s+/)).map((part) => part.trim()).filter(Boolean);
}

export function findExams(text: string, today: Date, termStart: Date | null, datedStatus: ExamStatus, source: string, url = ''): FoundExam[] {
  const found: FoundExam[] = [];
  const chunks = chunksOf(text);
  chunks.forEach((chunk, index) => {
    const matches = [...chunk.matchAll(keyword())];
    matches.forEach((match, position) => {
      const start = match.index ?? 0;
      const finish = start + match[0].length;
      const lead = chunk.slice(0, matches[0].index ?? 0);
      let part = chunk;
      if (matches.length > 1) {
        part = findDate(lead, today) || findWeek(lead)
          ? chunk.slice(position ? (matches[position - 1].index ?? 0) + matches[position - 1][0].length : 0, start)
          : chunk.slice(finish, position + 1 < matches.length ? matches[position + 1].index ?? chunk.length : chunk.length);
      }
      if (NOT_A_DATE.test(part)) return;
      const kind = match[1] ? 'midterm' : 'final';
      const number = examNumber(chunk, start, start + match[0].length);
      const evidence = chunk.slice(0, MAX_EVIDENCE_CHARS);
      let when = findDate(part, today);
      if (!when && index + 1 < chunks.length && chunk.length <= 24 && !keyword().test(chunks[index + 1])) when = findDate(chunks[index + 1].slice(0, 20), today);
      if (when) {
        found.push({ kind, number, startsOn: iso(when), endsOn: null, status: datedStatus, week: null, source, evidence, url });
        return;
      }
      let weeks = findWeek(part);
      if (!weeks && position === 0 && !match[0].toLowerCase().endsWith('s')) {
        const row = chunk.slice(0, start).match(TABLE_ROW);
        const [low, high] = PLAUSIBLE_ROW_WEEKS[kind];
        if (row && Number(row[1]) >= low && Number(row[1]) <= high && Number(row[1]) <= Number(row[2] ?? row[1]) && Number(row[2] ?? row[1]) <= MAX_WEEK) weeks = [Number(row[1]), Number(row[2] ?? row[1])];
      }
      if (weeks) {
        const base = monday(termStart ?? termStartGuess(today));
        found.push({
          kind, number, startsOn: iso(addDays(base, (weeks[0] - 1) * 7)), endsOn: iso(addDays(base, (weeks[1] - 1) * 7 + 4)),
          status: 'estimated', week: weeks[0], source, evidence, url,
        });
      }
    });
  });
  return found;
}

export function bestExams(found: FoundExam[], today: Date): FoundExam[] {
  const distance = (exam: FoundExam) => Math.abs(new Date(`${exam.startsOn}T00:00:00`).getTime() - today.getTime());
  const chosen = new Map<string, FoundExam>();
  for (const exam of found) {
    const key = `${exam.kind}:${exam.number}`;
    const old = chosen.get(key);
    if (!old || TRUST[exam.status] > TRUST[old.status] || (TRUST[exam.status] === TRUST[old.status] && distance(exam) < distance(old))) chosen.set(key, exam);
  }
  for (const kind of ['midterm', 'final']) {
    const plain = chosen.get(`${kind}:0`);
    const numbered = [...chosen.entries()].filter(([key]) => key.startsWith(`${kind}:`) && !key.endsWith(':0'));
    if (plain && numbered.length) {
      chosen.delete(`${kind}:0`);
      if (!numbered.some(([, exam]) => exam.startsOn === plain.startsOn)) {
        let free = 1;
        while (chosen.has(`${kind}:${free}`)) free += 1;
        chosen.set(`${kind}:${free}`, { ...plain, number: free });
      }
    }
  }
  return [...chosen.values()].sort((a, b) => a.startsOn.localeCompare(b.startsOn));
}

export function examsInItems(items: CanvasItem[], today: Date, termStarts: Record<string, Date>): Record<string, FoundExam[]> {
  const byCourse: Record<string, FoundExam[]> = {};
  for (const item of items) {
    if (!item.course) continue;
    let found: FoundExam[] = [];
    if (item.kind === 'announcement') {
      found = findExams(`${item.title}\n${item.body}`, today, termStarts[item.course] ?? null, 'announced', 'announcement', item.url);
    } else if (['assignment', 'quiz', 'event'].includes(item.kind) && item.dueAt && !NOT_A_DATE.test(item.title)) {
      const match = [...item.title.matchAll(keyword())][0];
      if (match) {
        const start = match.index ?? 0;
        found = [{
          kind: match[1] ? 'midterm' : 'final', number: examNumber(item.title, start, start + match[0].length), startsOn: iso(new Date(item.dueAt)),
          endsOn: null, status: 'announced', week: null, source: 'canvas', evidence: item.title.slice(0, MAX_EVIDENCE_CHARS), url: item.url,
        }];
      }
    }
    if (found.length) (byCourse[item.course] ??= []).push(...found);
  }
  return byCourse;
}

export function isOneDrive(url: string): boolean {
  const match = url.match(/^https:\/\/([^/?#:]+)/i);
  const host = match ? match[1].toLowerCase() : '';
  return host === '1drv.ms' || host === 'onedrive.live.com' || host.endsWith('.sharepoint.com');
}

/** A file in this app's cache. Nothing of ours goes with the request: Canvas's own file addresses carry their own permission. */
async function downloadPdf(url: string): Promise<string | null> {
  const target = new File(Paths.cache, 'syllabus-scan.pdf');
  try {
    if (target.exists) target.delete();
    const file = await File.downloadFileAsync(url, target);
    if (file.size > MAX_DOCUMENT_BYTES) return null;
    const data = await file.base64();
    // Only a real PDF goes on: "JVBERi" is "%PDF". A login page or anything else stops here.
    return data.startsWith('JVBERi') ? data : null;
  } catch {
    return null;
  } finally {
    try {
      if (target.exists) target.delete();
    } catch {
      // the cache cleans itself up
    }
  }
}

/** Gemini's limit is not the same as an unreadable file: the course is read again, not put off for a week. */
export class ScanLater extends Error {}

async function queuedRead(gemini: NonNullable<Gemini>, data: string): Promise<string> {
  const perMinute = minuteLimit({ provider: 'gemini', model: gemini.model }, (await readState()).meta.quotaSeen);
  try {
    return await queued('Syllabus okuma', gemini.model, perMinute, () => geminiReadPdf(gemini.key, gemini.model, data), true);
  } catch (error) {
    if (error instanceof RateLimited) throw new ScanLater(error.message);
    return '';
  }
}

export type CourseScan = { found: FoundExam[]; hasSyllabus: boolean; termStart: string | null; hint: string; attendance: AttendanceNote[] };
type Gemini = { key: string; model: string } | null;

export async function scanCourse(creds: { url: string; token: string }, courseId: number, today: Date, gemini: Gemini): Promise<CourseScan> {
  const info = await courseInfo(creds, courseId);
  const started = info?.term?.start_at ?? info?.start_at ?? null;
  const termStart = started ? new Date(started) : null;
  const found: FoundExam[] = [];
  let hasSyllabus = false;
  let hint = '';
  const rules = new Map<string, string>(); // what a course asks of attendance, and where it says so
  const noteAttendance = (source: string, text: string) => {
    for (const note of findAttendance(text)) if (!rules.has(note)) rules.set(note, source);
  };
  const pages: string[] = [info?.syllabus_body ?? '', await frontPage(creds, courseId)];
  const links: string[] = [];
  pages.forEach((page, index) => {
    const text = page ? htmlToText(page) : '';
    if (index === 0 && text.length >= MIN_SYLLABUS_CHARS) hasSyllabus = true;
    found.push(...findExams(text, today, termStart, 'syllabus', 'syllabus'));
    noteAttendance(index === 0 ? 'syllabus' : 'ders sayfası', text);
    links.push(...(page.match(LINK) ?? []).filter(isOneDrive));
  });
  // Files are often closed to students as a list, so what a page or a module links to is followed too.
  const named = new Set<number>(); // on the syllabus page itself: it counts whatever it is called
  const linkedFiles = new Set<number>();
  for (const match of (pages[0] ?? '').matchAll(FILE_LINK)) {
    named.add(Number(match[1]));
    linkedFiles.add(Number(match[1]));
  }
  for (const match of (pages[1] ?? '').matchAll(FILE_LINK)) linkedFiles.add(Number(match[1]));
  for (const item of await moduleItems(creds, courseId)) {
    if (item.type === 'ExternalUrl' && isOneDrive(item.external_url ?? '')) links.push(item.external_url);
    if (item.type === 'File' && item.content_id && SYLLABUS_WORDS.test(item.title ?? '')) linkedFiles.add(Number(item.content_id));
  }
  const files = new Map<number, any>();
  for (const id of [...linkedFiles].slice(0, MAX_LINKED_FILES)) {
    const file = await courseFile(creds, courseId, id);
    if (file?.id) files.set(file.id, file);
  }
  for (const word of FILE_SEARCHES) {
    for (const file of await courseFiles(creds, courseId, word)) files.set(file.id, file);
  }
  const wanted = [...files.values()].filter(
    (file) => /\.pdf$/i.test(file.display_name ?? '') && (named.has(file.id) || SYLLABUS_WORDS.test(file.display_name ?? '')) && (file.size ?? 0) <= MAX_DOCUMENT_BYTES && file.url,
  ).sort((a, b) => Number(named.has(b.id)) - Number(named.has(a.id)));
  const read = async (url: string): Promise<string> => {
    if (!gemini) return '';
    const data = await downloadPdf(url);
    return data ? queuedRead(gemini, data) : '';
  };
  for (const file of wanted.slice(0, MAX_FILES_PER_COURSE)) {
    if (!gemini) {
      hint = 'Syllabus dosyası var, okumak için Gemini anahtarı gerekiyor';
      break;
    }
    const text = await read(file.url);
    if (text.length >= MIN_SYLLABUS_CHARS / 4) hasSyllabus = true;
    found.push(...findExams(text, today, termStart, 'syllabus', 'file'));
    noteAttendance('syllabus dosyası', text);
  }
  for (const link of [...new Set(links)].slice(0, MAX_LINKS_PER_COURSE)) {
    if (!gemini) {
      hint ||= 'OneDrive linki var, okumak için Gemini anahtarı gerekiyor';
      break;
    }
    const text = await read(`${link}${link.includes('?') ? '&' : '?'}download=1`);
    if (text.length >= MIN_SYLLABUS_CHARS / 4) {
      hasSyllabus = true;
      found.push(...findExams(text, today, termStart, 'syllabus', 'onedrive', link));
      noteAttendance('OneDrive', text);
    } else if (!hasSyllabus) {
      hint = 'OneDrive linki açılamadı, giriş istiyor olabilir';
    }
  }
  const attendance = [...rules].map(([text, source]) => ({ source, text })).slice(0, MAX_ATTENDANCE_NOTES);
  return { found: bestExams(found, today), hasSyllabus, termStart: termStart ? iso(termStart) : null, hint: hasSyllabus ? '' : hint, attendance };
}
