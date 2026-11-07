/** The native side of phone mail, Eclipse Angus Mail: see AngusMail.kt. */
import { requireNativeModule } from 'expo';

export type MailAccount = { host: string; port: number; user: string; password: string };

export type SmtpMail = {
  host: string;
  user: string;
  password: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  imapPort: number;
  saveCopy: boolean;
};

export type NativeMail = {
  uid: number;
  unreadable?: boolean;
  subject?: string;
  sender?: string;
  from?: string;
  to?: string;
  date?: number | null;
  plain?: string;
  html?: string;
  attachments?: string[];
  headers?: Record<string, string>;
};

export type MailBatch = { uidvalidity: number; lastUid: number; mails: NativeMail[] };

type MailSocketModule = {
  countInbox(account: MailAccount): Promise<number>;
  readMail(request: MailAccount & { uidvalidity?: number; lastUid?: number; sinceMs: number; sent?: boolean }): Promise<MailBatch>;
  sendMail(mail: SmtpMail): Promise<{ id: string; sentCopy: boolean }>;
};

// Looked up when used rather than on import: without the native side only mail fails, not the whole app.
const native = () => requireNativeModule<MailSocketModule>('MailSocket');

export const countInbox = (account: MailAccount) => native().countInbox(account);
export const readMail = (request: MailAccount & { uidvalidity?: number; lastUid?: number; sinceMs: number; sent?: boolean }) => native().readMail(request);

/** Sends one mail, encrypted or not at all, and keeps its copy in Sent. */
export function sendSmtp(mail: SmtpMail): Promise<{ id: string; sentCopy: boolean }> {
  return native().sendMail(mail);
}
