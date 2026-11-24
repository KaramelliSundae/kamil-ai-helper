/**
 * What the rest of the phone's mail code needs to know about reading. The reading itself is Eclipse Angus
 * Mail, on the native side. A cursor saved before the POP3 fallback existed has no `protocol` field at all,
 * which is treated the same as `'imap'` below — no migration needed.
 */
export type MailCursor = { protocol: 'imap'; uidvalidity: number; lastUid: number } | { protocol: 'pop3'; lastItemId: number };

export class ImapAuthError extends Error {}
export class ImapError extends Error {}
