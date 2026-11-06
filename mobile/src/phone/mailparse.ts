/**
 * Reads a raw mail on the phone, the job the server gives to its sandbox. There is no sandbox here, so it does very little: JavaScript
 * reads text and the names of attachments, and nothing else is decoded. No image, no attachment and no HTML is ever opened or shown,
 * and no link is followed. A mail that makes no sense still gives what could be read. Raw strings hold one byte per character.
 */
import { htmlToText, normalizeTr } from './text';

export type ParsedMail = {
  subject: string;
  sender: string;
  from: string;
  date: string | null;
  body: string;
  attachments: string[];
  headers: Record<string, string>;
};

const MAX_BODY_CHARS = 20000;
const MAX_HTML_BYTES = 300 * 1024;
const MAX_PARTS = 40;
const MAX_DEPTH = 6;
const MAX_ATTACHMENTS = 20;
const MAX_NAME_CHARS = 120;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VALUES = new Map([...B64].map((char, index) => [char, index]));
// What differs from ISO-8859-1: the six Turkish letters, and in Windows-1254 the 0x80-0x9f range of typographic marks.
const TURKISH: Record<number, string> = { 0xd0: 'Ğ', 0xdd: 'İ', 0xde: 'Ş', 0xf0: 'ğ', 0xfd: 'ı', 0xfe: 'ş' };
const WINDOWS: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9f: 'Ÿ',
};

function fromBase64(text: string): string {
  let out = '';
  let bits = 0;
  let count = 0;
  for (const char of text) {
    const value = B64_VALUES.get(char);
    if (value === undefined) continue; // line ends, padding, junk
    bits = ((bits << 6) | value) & 0xffffff;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out += String.fromCharCode((bits >> count) & 0xff);
    }
  }
  return out;
}

function fromQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function fromUtf8(bytes: string): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const first = bytes.charCodeAt(i);
    const extra = first < 0x80 ? 0 : first >= 0xc2 && first < 0xe0 ? 1 : first >= 0xe0 && first < 0xf0 ? 2 : first >= 0xf0 && first < 0xf5 ? 3 : -1;
    if (extra < 0 || i + extra >= bytes.length + (extra ? 0 : 1)) {
      out += '�';
      i += 1;
      continue;
    }
    let code = extra === 0 ? first : first & (0x3f >> extra);
    let good = true;
    for (let k = 1; k <= extra; k += 1) {
      const next = bytes.charCodeAt(i + k);
      if ((next & 0xc0) !== 0x80) good = false;
      code = (code << 6) | (next & 0x3f);
    }
    if (!good || code > 0x10ffff) {
      out += '�';
      i += 1;
      continue;
    }
    out += String.fromCodePoint(code);
    i += extra + 1;
  }
  return out;
}

function decodeText(bytes: string, charset: string): string {
  const name = charset.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (name === 'iso88599' || name === 'latin5' || name === 'windows1254' || name === 'cp1254' || name === 'iso88591' || name === 'latin1' || name === 'windows1252' || name === 'cp1252' || name === 'usascii' || name === 'ascii') {
    const turkish = name === 'iso88599' || name === 'latin5' || name === 'windows1254' || name === 'cp1254';
    const windows = name.startsWith('windows') || name.startsWith('cp');
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      const code = bytes.charCodeAt(i);
      out += (turkish && TURKISH[code]) || (windows && WINDOWS[code]) || String.fromCharCode(code);
    }
    return out;
  }
  return fromUtf8(bytes); // UTF-8 is by far the likeliest for anything else
}

/** "=?utf-8?B?...?=" in a header, joining neighbours as the standard says. Other 8-bit text is taken as UTF-8. */
function decodeHeader(raw: string): string {
  return fromUtf8(raw)
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?\s]{1,40})\?([bBqQ])\?([^?\s]*)\?=/g, (_, charset: string, kind: string, text: string) => {
      const bytes = kind.toLowerCase() === 'b' ? fromBase64(text) : fromQuotedPrintable(text.replace(/_/g, ' '));
      return decodeText(bytes, charset);
    });
}

function splitPart(raw: string): { head: string; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  return match ? { head: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) } : { head: raw, body: '' };
}

function parseHead(head: string): Record<string, string> {
  const headers: Record<string, string> = Object.create(null);
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!(name in headers)) headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

function parameter(value: string | undefined, name: string): string {
  if (!value) return '';
  const extended = new RegExp(`;\\s*${name}\\*=(?:[^';\\s]*'[^';\\s]*')?([^;\\s]+)`, 'i').exec(value);
  if (extended) return decodeText(fromQuotedPrintable(extended[1].replace(/%/g, '=')), 'utf-8');
  const plain = new RegExp(`;\\s*${name}=(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value);
  return plain ? decodeHeader(plain[1] ?? plain[2] ?? '') : '';
}

function address(value: string): { name: string; from: string } {
  const decoded = decodeHeader(value);
  const angle = /^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(decoded);
  if (angle) return { name: angle[1].trim().replace(/^"|"$/g, '').trim(), from: angle[2] };
  return { name: '', from: /[^\s<>,;"]+@[^\s<>,;"]+/.exec(decoded)?.[0] ?? decoded.trim() };
}

type Walk = { plain: string; html: string; attachments: string[]; parts: number };

function walk(raw: string, depth: number, found: Walk): void {
  found.parts += 1;
  if (found.parts > MAX_PARTS || depth > MAX_DEPTH) return;
  const { head, body } = splitPart(raw);
  const headers = parseHead(head);
  const type = (headers['content-type'] ?? 'text/plain').split(';')[0].trim().toLowerCase();
  const boundary = parameter(headers['content-type'], 'boundary');
  if (type.startsWith('multipart/') && boundary) {
    // indexOf, not a pattern: a boundary is whatever the sender wrote.
    const mark = `--${boundary}`;
    const nextMark = (from: number) => {
      const newline = body.indexOf(`\n${mark}`, from);
      return newline < 0 ? -1 : newline + 1;
    };
    let at = body.startsWith(mark) ? 0 : nextMark(0);
    while (at >= 0 && found.parts <= MAX_PARTS) {
      if (body.startsWith('--', at + mark.length)) break; // the closing mark
      const start = body.indexOf('\n', at);
      if (start < 0) break;
      const next = nextMark(start);
      walk(next < 0 ? body.slice(start + 1) : body.slice(start + 1, next - 1), depth + 1, found);
      at = next;
    }
    return;
  }
  const disposition = headers['content-disposition'] ?? '';
  const name = parameter(disposition, 'filename') || parameter(headers['content-type'], 'name');
  if (/^attachment/i.test(disposition) || (name && !type.startsWith('text/'))) {
    if (name && found.attachments.length < MAX_ATTACHMENTS) found.attachments.push(name.slice(0, MAX_NAME_CHARS));
    return;
  }
  if (type !== 'text/plain' && type !== 'text/html') return;
  const encoding = (headers['content-transfer-encoding'] ?? '').trim().toLowerCase();
  const bytes = encoding === 'base64' ? fromBase64(body) : encoding === 'quoted-printable' ? fromQuotedPrintable(body) : body;
  const text = decodeText(bytes.slice(0, MAX_HTML_BYTES), parameter(headers['content-type'], 'charset') || 'utf-8');
  if (type === 'text/plain' && !found.plain && text.trim()) found.plain = text;
  if (type === 'text/html' && !found.html && text.trim()) found.html = text;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Fri, 6 Nov 2026 10:00:00 +0300". By hand, because Date.parse knows this form in some JavaScript engines and not in others. */
function parseDate(value: string): number | null {
  const match = /(\d{1,2})\s+([a-z]{3})[a-z]*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([+-])(\d{2})(\d{2}))?/i.exec(value);
  if (!match) return null;
  const month = MONTH_NAMES.indexOf(match[2].toLowerCase());
  if (month < 0) return null;
  const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
  const utc = Date.UTC(year, month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0));
  const offset = match[7] ? (match[7] === '-' ? -1 : 1) * (Number(match[8]) * 60 + Number(match[9])) * 60000 : 0;
  return Number.isNaN(utc) ? null : utc - offset;
}

function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
}

export function parseMail(raw: string, now: Date): ParsedMail {
  const headers = parseHead(splitPart(raw).head);
  const found: Walk = { plain: '', html: '', attachments: [], parts: 0 };
  walk(raw, 0, found);
  const who = address(headers.from ?? '');
  const parsed = parseDate(headers.date ?? '');
  // A sender writes its own date: one from the future must not sit on top of the list for ever.
  const date = parsed === null ? null : new Date(Math.min(parsed, now.getTime())).toISOString();
  let body = clean(found.plain || htmlToText(found.html)).slice(0, MAX_BODY_CHARS);
  if (found.attachments.length) body += `${body ? '\n\n' : ''}Ekler (telefonda açılmaz): ${found.attachments.map(clean).join(', ')}`;
  return {
    subject: clean(decodeHeader(headers.subject ?? '')).slice(0, 500),
    sender: clean(who.name || who.from).slice(0, 200),
    from: clean(who.from).slice(0, 200),
    date,
    body,
    attachments: found.attachments,
    headers,
  };
}

// The same rules as ai_ders/rules.py. Written for normalizeTr() text. JavaScript's \b and \w do not know Turkish letters.
const LETTER = 'a-z0-9_çğıöşü';
const URGENT = new RegExp(
  `(?<![${LETTER}])(s[ıi]nav|vize|final(?!ly|iz)|b[üu]t[üu]nleme|mazeret|quiz|[öo]dev|proje|teslim|son tarih|iptal|ertelen|erteleme|` +
    `de[ğg]i[şs]ikli[ğg]|acil|zorunlu|yoklama|devams[ıi]zl[ıi]k|ders kayd|kay[ıi]t yenile|harç|burs|exams?(?![${LETTER}])|examination|` +
    `midterm|assignment|deadline|due date(?![${LETTER}])|cancel|postpone|resched|urgent(?![${LETTER}])|mandatory(?![${LETTER}])|` +
    `makeup(?![${LETTER}])|make-up(?![${LETTER}]))`,
);
const CANVAS_SENDER = /instructure|canvas/;
const BULK_SENDER = /no-?reply|newsletter|b[üu]lten|mailer-daemon/;

/** Mail importance without a model. Nothing is dropped: mail that is not urgent waits in the list, without a notification. */
export function mailLevel(mail: ParsedMail): string {
  const sender = normalizeTr(mail.from);
  if (CANVAS_SENDER.test(sender)) return 'low'; // the same news already arrives from Canvas
  if (URGENT.test(normalizeTr(`${mail.subject}\n${mail.body.slice(0, 2000)}`))) return 'high';
  const precedence = (mail.headers.precedence ?? '').toLowerCase();
  const bulk = 'list-unsubscribe' in mail.headers || 'list-id' in mail.headers || ['bulk', 'list', 'junk'].includes(precedence);
  return bulk || 'auto-submitted' in mail.headers || BULK_SENDER.test(sender) ? 'low' : 'normal';
}
