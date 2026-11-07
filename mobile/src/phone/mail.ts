/** School mail in the phone mode: settings to a connection, raw mail to the items the rest of the app knows. */
import { openMailSocket } from '../../modules/mail-socket';
import type { CanvasItem } from './canvas';
import { countInbox, fetchMail, ImapAuthError, ImapError, MailCursor, MailTransport } from './imap';
import { threadOf } from '../mailThread';
import { mailLevel, parseMail } from './mailparse';
import { clearMailSettings, MailSettings } from './settings';
import { updateState } from './store';

const DEFAULT_PORT = 993; // TLS from the first byte: there is no plain connection here at all
const FIRST_RUN_DAYS = 14;

export type MailItem = CanvasItem & { level: string; thread: string; replyTo: string; messageId: string; references: string };
export { ImapAuthError };

/** "posta.uni.edu" or "posta.uni.edu:993", or null when it is not a bare server name. */
export function parseMailHost(value: string): { host: string; port: number } | null {
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(value.trim());
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : DEFAULT_PORT;
  return port >= 1 && port <= 65535 ? { host: match[1].toLowerCase(), port } : null;
}

async function connect(settings: Pick<MailSettings, 'host'>): Promise<MailTransport> {
  const target = parseMailHost(settings.host);
  if (!target) throw new ImapError('Mail sunucusunun adı geçersiz');
  return openMailSocket(target.host, target.port);
}

/** Tries the account. Returns how many mails the inbox holds. */
export async function checkMailAccount(settings: Pick<MailSettings, 'host' | 'user' | 'password'>): Promise<number> {
  return countInbox(await connect(settings), settings.user, settings.password);
}

export async function readNewMail(
  settings: MailSettings, cursor: MailCursor | null, now: Date,
): Promise<{ items: MailItem[]; cursor: MailCursor }> {
  const since = new Date(now.getTime() - FIRST_RUN_DAYS * 864e5);
  const result = await fetchMail(await connect(settings), settings.user, settings.password, cursor, since);
  const items = result.mails.map(({ uid, uidvalidity, data }) => {
    const mail = parseMail(data, now);
    return {
      key: `mail:${uidvalidity}:${uid}`,
      kind: 'mail',
      title: mail.subject || '(konusuz)',
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
    };
  });
  return { items, cursor: result.cursor };
}

/** The account and everything read through it, off this phone. The mailbox itself is untouched. */
export async function forgetMail(): Promise<void> {
  await clearMailSettings();
  await updateState((state) => {
    for (const item of Object.values(state.items)) if (item.kind === 'mail') delete state.items[item.key];
    state.events = state.events.filter((event) => !event.itemKey.startsWith('mail:') && event.itemKey !== 'system:mail');
    state.meta.mailCursor = state.meta.mailFailures = state.meta.mailError = undefined;
    state.meta.mailWindowRead = false;
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
