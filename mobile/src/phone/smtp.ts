/**
 * Sending one approved mail. Only the Onaylar screen gets here, after the student taps: the model has no way to it. Everything
 * travels over TLS, the socket itself sees to that, and every value going into a header is cleaned so a line of text cannot add a header.
 */
import { openMailSocket, openStartTlsSocket } from '../../modules/mail-socket';
import type { MailTransport } from './imap';

export class SmtpError extends Error {}

const STARTTLS_PORT = 587;
const TLS_PORT = 465;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BARE_ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;
const MESSAGE_ID = /^<[^<>\s]+>$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export type Outgoing = {
  from: string;
  to: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
};

function utf8(text: string): string {
  return encodeURIComponent(text.replace(LONE_SURROGATE, '\uFFFD')).replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function base64(bytes: string): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes.charCodeAt(i);
    const b = i + 1 < bytes.length ? bytes.charCodeAt(i + 1) : 0;
    const c = i + 2 < bytes.length ? bytes.charCodeAt(i + 2) : 0;
    out += BASE64[a >> 2] + BASE64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? BASE64[c & 63] : '=';
  }
  return out;
}

/** "Ayşe <a@b.edu>, c@d.edu" to the bare addresses, or an error: nothing odd goes to a server as a recipient. */
export function recipients(to: string): string[] {
  const found = to.split(/[,;]/).map((part) => part.trim()).filter(Boolean).map((part) => /<([^<>]+)>\s*$/.exec(part)?.[1]?.trim() ?? part);
  if (!found.length || found.some((address) => !BARE_ADDRESS.test(address))) throw new SmtpError('Alıcı adresi geçersiz');
  return found;
}

function encodedSubject(subject: string): string {
  const clean = subject.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(clean) && clean.length <= 900) return clean;
  const words: string[] = [];
  let part = '';
  for (const char of clean) {
    if (utf8(part + char).length > 45) {
      words.push(part);
      part = '';
    }
    part += char;
  }
  if (part) words.push(part);
  return words.map((word) => `=?UTF-8?B?${base64(utf8(word))}?=`).join('\r\n ');
}

const pad = (value: number) => String(value).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The whole message as bytes, one character each, ready for DATA. The body is base64, so no line of it can end the message. */
export function buildMessage(mail: Outgoing, now: Date, messageId: string): string {
  const date = `${DAYS[now.getUTCDay()]}, ${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} +0000`;
  const references = (mail.references?.match(/<[^<>\s]+>/g) ?? []).slice(-10).join(' ');
  const headers = [
    `From: ${mail.from}`,
    `To: ${mail.to.join(', ')}`,
    `Subject: ${encodedSubject(mail.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    ...(mail.inReplyTo && MESSAGE_ID.test(mail.inReplyTo) ? [`In-Reply-To: ${mail.inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const lines = base64(utf8(mail.body.replace(/\r?\n/g, '\r\n'))).match(/.{1,76}/g) ?? [];
  return `${headers.join('\r\n')}\r\n\r\n${lines.join('\r\n')}\r\n`;
}

class Dialog {
  private buffer = '';

  constructor(private readonly transport: MailTransport) {}

  /** One whole reply: "250-..." lines, up to the "250 ...". */
  async reply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end < 0) {
        const chunk = await this.transport.read();
        if (!chunk) throw new SmtpError('Mail sunucusu bağlantıyı kapattı');
        this.buffer += chunk;
        if (this.buffer.length > 65536) throw new SmtpError('Mail sunucusundan anlaşılmayan cevap geldi');
        continue;
      }
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      lines.push(line);
      if (line.length < 4 || line[3] === ' ') {
        const code = Number(line.slice(0, 3));
        if (!code) throw new SmtpError('Mail sunucusundan anlaşılmayan cevap geldi');
        return { code, text: lines.join('\n') };
      }
    }
  }

  async say(line: string, wanted: number, problem: string): Promise<string> {
    await this.transport.write(`${line}\r\n`);
    const { code, text } = await this.reply();
    if (code !== wanted) throw new SmtpError(`${problem} (${code})`);
    return text;
  }
}

/** One message over a connection that is already encrypted. `greeted`: its greeting came before the encryption started. */
export async function deliver(transport: MailTransport, greeted: boolean, user: string, password: string, mail: Outgoing, message: string): Promise<void> {
  const dialog = new Dialog(transport);
  try {
    if (!greeted && (await dialog.reply()).code !== 220) throw new SmtpError('Mail sunucusu bağlantıyı kabul etmedi');
    const hello = await dialog.say('EHLO kamil', 250, 'Mail sunucusu bağlantıyı kabul etmedi');
    const plain = base64(utf8(`\0${user}\0${password}`));
    await transport.write(/AUTH[ =-][^\n]*\bPLAIN\b/i.test(hello) || !/AUTH[ =-][^\n]*\bLOGIN\b/i.test(hello) ? `AUTH PLAIN ${plain}\r\n` : 'AUTH LOGIN\r\n');
    let auth = await dialog.reply();
    if (auth.code === 334) {
      await transport.write(`${base64(utf8(user))}\r\n`);
      auth = await dialog.reply();
      if (auth.code === 334) {
        await transport.write(`${base64(utf8(password))}\r\n`);
        auth = await dialog.reply();
      }
    }
    if (auth.code !== 235) throw new SmtpError('Mail sunucusu şifreyi kabul etmedi');
    await dialog.say(`MAIL FROM:<${mail.from}>`, 250, 'Mail sunucusu gönderen adresini kabul etmedi');
    for (const address of mail.to) {
      await transport.write(`RCPT TO:<${address}>\r\n`);
      const { code } = await dialog.reply();
      if (code !== 250 && code !== 251) throw new SmtpError(`Mail sunucusu alıcıyı kabul etmedi: ${address}`);
    }
    await dialog.say('DATA', 354, 'Mail sunucusu maili kabul etmedi');
    await transport.write(message);
    await dialog.say('.', 250, 'Mail sunucusu maili kabul etmedi');
    await transport.write('QUIT\r\n').catch(() => undefined);
  } finally {
    await transport.close().catch(() => undefined);
  }
}

/** Port 587 first, then 465. Neither is ever used without TLS, and a bad certificate is not something to go around. */
export async function sendMail(host: string, user: string, password: string, mail: Outgoing, now: Date): Promise<string> {
  const domain = mail.from.split('@')[1];
  const random = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  const messageId = `<${now.getTime().toString(36)}.${random}@${domain}>`;
  const message = buildMessage(mail, now, messageId);
  let transport: MailTransport;
  let greeted = true;
  try {
    transport = await openStartTlsSocket(host, STARTTLS_PORT);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ERR_MAIL_CERTIFICATE' || /certificate|cert path|trust anchor/i.test(String(error))) {
      throw new SmtpError('Mail sunucusunun sertifikası doğrulanamadı');
    }
    try {
      transport = await openMailSocket(host, TLS_PORT);
      greeted = false;
    } catch {
      throw new SmtpError('Mail sunucusuna gönderim için bağlanılamadı');
    }
  }
  await deliver(transport, greeted, user, password, mail, message);
  return messageId;
}
