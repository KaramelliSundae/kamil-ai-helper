/** What the rest of the phone's mail code needs to know about reading. The reading itself is Eclipse Angus Mail, on the native side. */
export type MailCursor = { uidvalidity: number; lastUid: number };

export class ImapAuthError extends Error {}
export class ImapError extends Error {}
