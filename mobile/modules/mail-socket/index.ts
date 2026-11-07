/** The native side of phone mail: see MailSocketModule.kt. Strings here hold one byte per character. */
import { requireNativeModule } from 'expo';

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
};

type MailSocketModule = {
  open(host: string, port: number, timeoutMs: number): Promise<number>;
  sendMail(mail: SmtpMail): Promise<string>;
  write(handle: number, data: string): Promise<void>;
  read(handle: number): Promise<string>;
  close(handle: number): Promise<void>;
};

const TIMEOUT_MS = 30000;

// Looked up when used rather than on import: without the native side only mail fails, not the whole app.
const native = () => requireNativeModule<MailSocketModule>('MailSocket');

function connection(handle: number) {
  const socket = native();
  return {
    write: (data: string) => socket.write(handle, data),
    read: () => socket.read(handle),
    close: () => socket.close(handle),
  };
}

export async function openMailSocket(host: string, port: number) {
  return connection(await native().open(host, port, TIMEOUT_MS));
}

/** Sends one mail with Eclipse Angus Mail, encrypted or not at all. Returns its Message-ID. */
export function sendSmtp(mail: SmtpMail): Promise<string> {
  return native().sendMail(mail);
}
