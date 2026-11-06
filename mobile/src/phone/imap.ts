/**
 * The smallest IMAP client that reads a mailbox without changing it: EXAMINE rather than SELECT, and BODY.PEEK, so a mail that was
 * unread stays unread. It only moves bytes; mailparse.ts reads them. Strings here hold one byte per character.
 */
export type MailTransport = { write(data: string): Promise<void>; read(): Promise<string>; close(): Promise<void> };
export type MailCursor = { uidvalidity: number; lastUid: number };
export type RawMail = { uid: number; uidvalidity: number; data: string };

export class ImapAuthError extends Error {}
export class ImapError extends Error {}

export const MAX_MAIL_BYTES = 256 * 1024; // enough for any text; attachments beyond it are not fetched
const MAX_PER_ROUND = 20; // the phone wakes for a short while, and the rest comes next round
const FIRST_RUN_MAILS = 30;
const MAX_LINE_BYTES = 64 * 1024;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Reply = { text: string; literals: string[] };

function utf8(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) out += char;
    else if (code < 0x800) out += String.fromCharCode(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out += String.fromCharCode(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out += String.fromCharCode(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return out;
}

function quoted(text: string): string {
  return `"${text.replace(/[\\"]/g, '\\$&')}"`;
}

class Session {
  private buffer = '';
  private tags = 0;

  constructor(private readonly transport: MailTransport) {}

  private async fill(): Promise<void> {
    const chunk = await this.transport.read();
    if (!chunk) throw new ImapError('Mail sunucusu bağlantıyı kapattı');
    this.buffer += chunk;
  }

  private async line(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return line;
      }
      if (this.buffer.length > MAX_LINE_BYTES) throw new ImapError('Mail sunucusundan anlaşılmayan cevap geldi');
      await this.fill();
    }
  }

  private async bytes(count: number): Promise<string> {
    while (this.buffer.length < count) await this.fill();
    const data = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    return data;
  }

  /** One response, with the literals it carries: "{5}" at the end of a line means five raw bytes follow. */
  private async reply(): Promise<Reply> {
    let text = await this.line();
    const literals: string[] = [];
    for (;;) {
      const size = /\{(\d+)\}$/.exec(text);
      if (!size) return { text, literals };
      if (Number(size[1]) > MAX_MAIL_BYTES + 1024) throw new ImapError('Mail sunucusundan beklenenden büyük cevap geldi');
      literals.push(await this.bytes(Number(size[1])));
      text = `${text.slice(0, size.index)}${await this.line()}`;
    }
  }

  private tag(): string {
    this.tags += 1;
    return `k${this.tags}`;
  }

  /** Reads up to the tagged answer. Returns the untagged replies and whether the server said OK. */
  private async finish(tag: string): Promise<{ replies: Reply[]; ok: boolean; said: string }> {
    const replies: Reply[] = [];
    for (;;) {
      const reply = await this.reply();
      if (reply.text.startsWith(`${tag} `)) {
        const said = reply.text.slice(tag.length + 1);
        return { replies, ok: /^OK\b/i.test(said), said };
      }
      if (/^\* BYE\b/i.test(reply.text)) throw new ImapError('Mail sunucusu bağlantıyı kapattı');
      replies.push(reply);
    }
  }

  private async run(command: string): Promise<Reply[]> {
    const tag = this.tag();
    await this.transport.write(`${tag} ${command}\r\n`);
    const { replies, ok } = await this.finish(tag);
    if (!ok) throw new ImapError(`Mail sunucusu isteği reddetti (${command.split(' ')[0]})`);
    return replies;
  }

  async greet(): Promise<void> {
    if (!/^\* (OK|PREAUTH)\b/i.test((await this.reply()).text)) throw new ImapError('Bu bir mail sunucusu gibi görünmüyor');
  }

  private async continuation(): Promise<void> {
    if (!(await this.reply()).text.startsWith('+')) throw new ImapAuthError('Mail sunucusu girişi kabul etmedi');
  }

  async login(user: string, password: string): Promise<void> {
    if (/[\r\n\0]/.test(user + password)) throw new ImapAuthError('Kullanıcı adı veya şifre geçersiz karakter içeriyor');
    const tag = this.tag();
    // eslint-disable-next-line no-control-regex
    if (/^[\x20-\x7e]*$/.test(user + password)) {
      await this.transport.write(`${tag} LOGIN ${quoted(user)} ${quoted(password)}\r\n`);
    } else {
      const [name, secret] = [utf8(user), utf8(password)];
      await this.transport.write(`${tag} LOGIN {${name.length}}\r\n`);
      await this.continuation();
      await this.transport.write(`${name} {${secret.length}}\r\n`);
      await this.continuation();
      await this.transport.write(`${secret}\r\n`);
    }
    if (!(await this.finish(tag)).ok) throw new ImapAuthError('Kullanıcı adı veya şifre kabul edilmedi');
  }

  async status(): Promise<{ uidvalidity: number; uidnext: number; messages: number }> {
    const text = (await this.run('STATUS INBOX (MESSAGES UIDVALIDITY UIDNEXT)')).map((reply) => reply.text).join(' ');
    const number = (name: string) => Number(new RegExp(`${name} (\\d+)`, 'i').exec(text)?.[1] ?? NaN);
    const found = { uidvalidity: number('UIDVALIDITY'), uidnext: number('UIDNEXT'), messages: number('MESSAGES') };
    if (Number.isNaN(found.uidvalidity) || Number.isNaN(found.uidnext)) throw new ImapError('Mail sunucusundan anlaşılmayan cevap geldi');
    return found;
  }

  async examine(): Promise<void> {
    await this.run('EXAMINE INBOX');
  }

  async search(criteria: string): Promise<number[]> {
    const lines = (await this.run(`UID SEARCH ${criteria}`)).map((reply) => reply.text).filter((text) => /^\* SEARCH\b/i.test(text));
    return lines.flatMap((text) => (text.match(/\d+/g) ?? []).map(Number)).sort((a, b) => a - b);
  }

  async fetch(uid: number): Promise<string> {
    const replies = await this.run(`UID FETCH ${uid} BODY.PEEK[]<0.${MAX_MAIL_BYTES}>`);
    return replies.find((reply) => reply.literals.length)?.literals[0] ?? '';
  }

  async logout(): Promise<void> {
    await this.run('LOGOUT').catch(() => undefined);
  }
}

async function inSession<T>(transport: MailTransport, user: string, password: string, work: (session: Session) => Promise<T>): Promise<T> {
  const session = new Session(transport);
  try {
    await session.greet();
    await session.login(user, password);
    const result = await work(session);
    await session.logout();
    return result;
  } finally {
    await transport.close().catch(() => undefined);
  }
}

/** Logs in and counts the inbox, to show the student the settings work. */
export function countInbox(transport: MailTransport, user: string, password: string): Promise<number> {
  return inSession(transport, user, password, async (session) => (await session.status()).messages);
}

function imapDate(date: Date): string {
  return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

/**
 * Mail newer than the cursor, oldest first. Without a cursor it reads the newest mail since a date, so that Kamil knows the last days:
 * the caller stores those quietly. A new UIDVALIDITY means the server renumbered the folder, so old numbers mean nothing and reading
 * goes on from the newest mail.
 */
export function fetchMail(
  transport: MailTransport, user: string, password: string, cursor: MailCursor | null, since: Date,
): Promise<{ mails: RawMail[]; cursor: MailCursor }> {
  return inSession(transport, user, password, async (session) => {
    const { uidvalidity, uidnext } = await session.status();
    if (cursor && cursor.uidvalidity !== uidvalidity) return { mails: [], cursor: { uidvalidity, lastUid: uidnext - 1 } };
    await session.examine();
    const uids = cursor
      ? (await session.search(`UID ${cursor.lastUid + 1}:*`)).filter((uid) => uid > cursor.lastUid).slice(0, MAX_PER_ROUND) // "n:*" always matches the newest
      : (await session.search(`SINCE ${imapDate(since)}`)).slice(-FIRST_RUN_MAILS);
    const mails: RawMail[] = [];
    for (const uid of uids) mails.push({ uid, uidvalidity, data: await session.fetch(uid) });
    const last = uids.length ? uids[uids.length - 1] : -1;
    // Mail that arrived after STATUS may be in this batch already, so the next round must not fetch it again.
    const lastUid = cursor ? Math.max(cursor.lastUid, last) : Math.max(uidnext - 1, last);
    return { mails, cursor: { uidvalidity, lastUid } };
  });
}
