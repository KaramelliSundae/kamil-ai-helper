/** A mail as the app knows it, from what Eclipse Angus Mail read on the native side, and how important it looks. */
import { htmlToText, normalizeTr } from './text';
import type { NativeMail } from '../../modules/mail-socket';

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

function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
}

export function parseMail(mail: NativeMail, now: Date): ParsedMail {
  const attachments = mail.attachments ?? [];
  // A sender writes its own date: one from the future must not sit on top of the list for ever.
  const date = mail.date ? new Date(Math.min(mail.date, now.getTime())).toISOString() : null;
  let body = clean(mail.plain || htmlToText(mail.html ?? '')).slice(0, MAX_BODY_CHARS);
  if (attachments.length) body += `${body ? '\n\n' : ''}Ekler (telefonda açılmaz): ${attachments.map(clean).join(', ')}`;
  const from = clean(mail.from ?? '').slice(0, 200);
  return {
    subject: clean(mail.subject ?? '').slice(0, 500),
    sender: clean(mail.sender || from).slice(0, 200),
    from,
    date,
    body,
    attachments,
    headers: mail.headers ?? {},
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
