/** School mail in the phone mode: settings to a connection, what Angus read to the items the rest of the app knows. */
import { countInbox, readMail } from '../../modules/mail-socket';
import type { CanvasItem } from './canvas';
import { ImapAuthError, ImapError, MailCursor } from './imap';
import { OUTGOING_KEY, threadOf } from '../mailThread';
import { isBulkMail, mailLevel, parseMail } from './mailparse';
import { clearMailSettings, MailSettings } from './settings';
import { updateState } from './store';

const DEFAULT_PORT = 993; // TLS from the first byte: there is no plain connection here at all
const FIRST_RUN_DAYS = 14;

export type MailItem = CanvasItem & { level: string; thread: string; replyTo: string; messageId: string; references: string; bulk: boolean };
export { ImapAuthError };

/** "posta.uni.edu" or "posta.uni.edu:993", or null when it is not a bare server name. */
export function parseMailHost(value: string): { host: string; port: number } | null {
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(value.trim());
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : DEFAULT_PORT;
  return port >= 1 && port <= 65535 ? { host: match[1].toLowerCase(), port } : null;
}

function account(settings: Pick<MailSettings, 'host' | 'user' | 'password'>, protocol: 'imap' | 'pop3' = 'imap') {
  const target = parseMailHost(settings.host);
  if (!target) throw new ImapError('Mail sunucusunun adı geçersiz');
  return { host: target.host, port: target.port, user: settings.user, password: settings.password, protocol };
}

function refused(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ERR_MAIL_AUTH') return new ImapAuthError('Kullanıcı adı veya şifre kabul edilmedi');
  return error instanceof Error ? error : new ImapError('Mail sunucusuna bağlanılamadı');
}

/** Tries the account. Returns how many mails the inbox holds. `mode: 'pop3'` is the manual override in
 * Settings; `'auto'` still falls back to POP3 on its own if IMAP itself fails (not on a wrong password),
 * so an account can be added or tested while IMAP is down even before the student finds that switch. */
export async function checkMailAccount(settings: Pick<MailSettings, 'host' | 'user' | 'password'>, mode: 'auto' | 'pop3' = 'auto'): Promise<number> {
  if (mode === 'auto') {
    try {
      return await countInbox(account(settings, 'imap'));
    } catch (error) {
      const converted = refused(error);
      if (converted instanceof ImapAuthError) throw converted; // a wrong password: POP3 would refuse it too
    }
  }
  try {
    return await countInbox(account(settings, 'pop3'));
  } catch (error) {
    throw refused(error);
  }
}

function toMailItem(raw: Awaited<ReturnType<typeof readMail>>['mails'][number], key: string, now: Date): MailItem {
  const mail = parseMail(raw, now);
  return {
    key,
    kind: 'mail',
    title: raw.unreadable ? '(açılamayan mail)' : mail.subject || '(konusuz)',
    course: '',
    url: '',
    sender: mail.sender,
    body: mail.body,
    dueAt: null,
    postedAt: mail.date ?? now.toISOString(),
    grade: null,
    submitted: false,
    level: mailLevel(mail),
    thread: threadOf(mail.headers, mail.subject),
    // Not the Reply-To header: anyone can write there, and a reply should go to who it seems to come from.
    replyTo: mail.from,
    messageId: mail.headers['message-id']?.match(/<[^<>\s]+>/)?.[0] ?? '',
    references: mail.headers.references ?? '',
    bulk: isBulkMail(mail),
  };
}

async function readNewMailImap(settings: MailSettings, cursor: { uidvalidity: number; lastUid: number } | null, since: number, now: Date) {
  const batch = await readMail({ ...account(settings, 'imap'), ...(cursor ?? {}), sinceMs: since });
  const items = batch.mails.map((raw) => toMailItem(raw, `mail:${batch.uidvalidity}:${raw.uid}`, now));
  return { items, cursor: { protocol: 'imap' as const, uidvalidity: batch.uidvalidity, lastUid: batch.lastUid } };
}

async function readNewMailPop3(settings: MailSettings, lastItemId: number | null, now: Date) {
  const batch = await readMail({ ...account(settings, 'pop3'), lastUid: lastItemId ?? undefined, sinceMs: 0 });
  const items = batch.mails.map((raw) => toMailItem(raw, `mail:pop3:${raw.uid}`, now));
  return { items, cursor: { protocol: 'pop3' as const, lastItemId: batch.lastUid } };
}

/**
 * `mode`: `'auto'` (default) tries IMAP first and only falls back to POP3 if IMAP itself fails this round —
 * never on a wrong password, which POP3 would refuse the same way. `'pop3'` is the manual override, or IMAP
 * already known to be down. Crossing from a POP3 cursor back to IMAP passes no cursor at all, which the
 * native side already reads as "search since the first-run window" — so nothing in between is missed, and
 * duplicates against what POP3 already delivered are caught by the Message-ID check in `watcher.ts`.
 */
export async function readNewMail(
  settings: MailSettings, cursor: MailCursor | null, now: Date, mode: 'auto' | 'pop3' = 'auto',
): Promise<{ items: MailItem[]; cursor: MailCursor }> {
  const since = now.getTime() - FIRST_RUN_DAYS * 864e5;
  if (mode === 'auto') {
    try {
      return await readNewMailImap(settings, cursor && cursor.protocol === 'imap' ? cursor : null, since, now);
    } catch (error) {
      const converted = refused(error);
      if (converted instanceof ImapAuthError) throw converted; // a wrong password: POP3 would refuse it too
    }
  }
  try {
    return await readNewMailPop3(settings, cursor && cursor.protocol === 'pop3' ? cursor.lastItemId : null, now);
  } catch (error) {
    throw refused(error);
  }
}

/** The student's own mails, so a conversation shows both sides. A mailbox with no Sent folder just has none —
 * and POP3 has no folder concept at all, so a forced POP3 mode is the same as "no Sent folder". */
export async function readSentMail(
  settings: MailSettings, cursor: { uidvalidity: number; lastUid: number } | null, now: Date, mode: 'auto' | 'pop3' = 'auto',
): Promise<{ items: MailItem[]; cursor: { uidvalidity: number; lastUid: number } } | null> {
  if (mode === 'pop3') return null;
  let batch;
  try {
    batch = await readMail({ ...account(settings, 'imap'), ...(cursor ?? {}), sinceMs: now.getTime() - FIRST_RUN_DAYS * 864e5, sent: true });
  } catch {
    return null; // only the other half of a conversation: the inbox goes on without it
  }
  if (!batch.uidvalidity) return null;
  const items = batch.mails.filter((raw) => !raw.unreadable).map((raw) => {
    const mail = parseMail(raw, now);
    return {
      key: `${OUTGOING_KEY}${batch.uidvalidity}:${raw.uid}`,
      kind: 'mail',
      title: mail.subject || '(konusuz)',
      course: '',
      url: '',
      sender: 'Sen',
      body: mail.body,
      dueAt: null,
      postedAt: mail.date ?? now.toISOString(),
      grade: null,
      submitted: false,
      level: 'normal',
      thread: threadOf(mail.headers, mail.subject),
      replyTo: raw.to ?? '',
      messageId: mail.headers['message-id']?.match(/<[^<>\s]+>/)?.[0] ?? '',
      references: mail.headers.references ?? '',
      bulk: false, // the student's own mail is never scored
    };
  });
  return { items, cursor: { uidvalidity: batch.uidvalidity, lastUid: batch.lastUid } };
}

/** The account and everything read through it, off this phone. The mailbox itself is untouched. */
export async function forgetMail(): Promise<void> {
  await clearMailSettings();
  await updateState((state) => {
    for (const item of Object.values(state.items)) if (item.kind === 'mail') delete state.items[item.key];
    state.events = state.events.filter((event) => !event.itemKey.startsWith('mail:') && event.itemKey !== 'system:mail');
    state.meta.mailCursor = state.meta.mailFailures = state.meta.mailError = undefined;
    state.meta.mailWindowRead = false;
    state.meta.sentCursor = undefined;
    if (state.meta.backfilled) state.meta.backfilled.mail = false; // a new account gets its two weeks too
  });
}

/** What to tell the student. A certificate problem is said plainly: it may mean someone is in the way. */
export function mailProblem(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  if (error instanceof ImapAuthError || error instanceof ImapError) return text;
  if (/certificate|CertPath|SSL|Trust anchor|handshake|Hostname|ERR_MAIL_CERTIFICATE/i.test(text)) {
    return 'Mail sunucusunun sertifikası doğrulanamadı, bağlanmadım. Sunucu adını kontrol et; ağda bir sorun da olabilir.';
  }
  return 'Mail sunucusuna bağlanılamadı. Sunucu adını ve internet bağlantını kontrol et.';
}
