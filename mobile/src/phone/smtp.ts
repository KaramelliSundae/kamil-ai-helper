/**
 * Sending one approved mail. Only the Onaylar screen gets here, after the student taps: the model has no way to it. The sending itself
 * is Eclipse Angus Mail on the native side, encrypted or not at all. What goes in was checked here first as well.
 */
import { sendSmtp } from '../../modules/mail-socket';

export class SmtpError extends Error {}

// Printable ASCII only: see SendMail.kt. Anything else goes through the mail app, if at all.
const BARE_ADDRESS = /^[!#-'*+\-./0-9=?A-Z^-~]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export type Outgoing = {
  from: string;
  to: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
};

/** "Ayşe <a@b.edu>, c@d.edu" to the bare addresses, or an error: nothing odd goes to a server as a recipient. */
export function recipients(to: string): string[] {
  const found = to.split(/[,;]/).map((part) => part.trim()).filter(Boolean).map((part) => /<([^<>]+)>\s*$/.exec(part)?.[1]?.trim() ?? part);
  if (!found.length || found.some((address) => !BARE_ADDRESS.test(address))) throw new SmtpError('Alıcı adresi geçersiz');
  return found;
}

function problem(error: unknown): string {
  switch ((error as { code?: string } | null)?.code) {
    case 'ERR_MAIL_AUTH': return 'Mail sunucusu şifreyi kabul etmedi';
    case 'ERR_MAIL_CERTIFICATE': return 'Mail sunucusuyla güvenli bağlantı kurulamadı, bu yüzden gönderilmedi';
    case 'ERR_MAIL_RECIPIENT': return 'Mail sunucusu alıcıyı veya maili kabul etmedi';
    default: return 'Mail gönderilemedi. İnternet açık mı?';
  }
}

export async function sendMail(host: string, user: string, password: string, mail: Outgoing): Promise<string> {
  try {
    return await sendSmtp({ host, user, password, ...mail });
  } catch (error) {
    throw new SmtpError(problem(error));
  }
}
