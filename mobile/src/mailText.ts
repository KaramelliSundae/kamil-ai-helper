import { appConfig } from './config';

/**
 * Turns the plain text of a mail into blocks the detail sheet can lay out: paragraphs, bullet lists,
 * separators and link cards. School mails repeat themselves in English after a separator, so that
 * half is split off to be shown on request, and so are quoted earlier messages.
 */

export type Block =
  | { kind: 'paragraph'; text: string; label: boolean; signature?: boolean }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'divider' }
  /** `host` is always the real hostname from the URL, never a display name. */
  | { kind: 'link'; url: string; name: string; host: string; service?: string };

export type MailText = {
  main: Block[];
  /** The English copy of a bilingual mail. */
  english: Block[];
  /** Earlier messages quoted below a reply. */
  quoted: Block[];
};

const URL = /\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;
const SEPARATOR = /^[\s\-_=*.·•~–—+#]{3,}$/;
const BULLET = /^\s*(?:[-•*·▪●◦]|\d{1,2}[.)])\s+/;
const QUOTE_START = /(?:wrote|yazdı)\s*:\s*$|^-{2,}\s*(?:Original Message|Orijinal Mesaj|Forwarded message|İletilen mesaj)|^(?:Bu e-?posta mesaj[ıi]|Bu e-?posta ve ekleri|Yasal uyar[ıi]|This (?:e-?mail|message)(?: and any attachments?)? (?:is|are|may)|Disclaimer\b|Confidentiality notice)/i;
const TURKISH = /[çğıöşüÇĞİÖŞÜ]/g;
const ENGLISH_WORDS = /\b(?:the|and|of|to|you|your|we|our|is|are|will|for|dear)\b/gi;
const GENERIC_CAPTION = /^(?:link|links|bağlantı|bağlantılar|url|adres|web|website|web sitesi)$/i;
const CLOSING = /^(?:Saygılarımızla|Saygılarımla|Saygılar|İyi çalışmalar|Sağlıklı günler|Teşekkürler|Best regards|Kind regards|Regards|Sincerely|Best wishes|Thanks)\b/i;
const ENGLISH_OPENING = /^(?:Dear|Hello|Hi|Greetings)\b/;

// Labels for well-known hosts. Matched on the real hostname only, by whole domain, so
// "evil.example/teams.microsoft.com" or "teams.microsoft.com.evil.example" never earns a label.
const SERVICES: { host: string; path?: string; name: string }[] = [
  { host: 'teams.microsoft.com', name: 'Microsoft Teams' },
  { host: 'teams.live.com', name: 'Microsoft Teams' },
  { host: 'zoom.us', name: 'Zoom' },
  { host: 'forms.gle', name: 'Google Form' },
  { host: 'docs.google.com', path: '/forms', name: 'Google Form' },
  { host: 'forms.office.com', name: 'Microsoft Form' },
  { host: 'docs.google.com', name: 'Google Docs' },
  { host: 'drive.google.com', name: 'Google Drive' },
  { host: 'meet.google.com', name: 'Google Meet' },
  { host: 'youtube.com', name: 'YouTube' },
  { host: 'youtu.be', name: 'YouTube' },
  { host: 'linkedin.com', name: 'LinkedIn' },
  { host: 'instagram.com', name: 'Instagram' },
];

function onDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The hostname a link really goes to, read from the URL alone. */
export function hostOf(url: string): string {
  try {
    return new globalThis.URL(url).hostname.toLowerCase();
  } catch {
    return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].replace(/^.*@/, '').toLowerCase();
  }
}

export function linkName(url: string): { name: string; host: string; service?: string } {
  const host = hostOf(url);
  let path = '';
  try {
    path = new globalThis.URL(url).pathname;
  } catch {
    // the host alone decides
  }
  const service = SERVICES.find((entry) => onDomain(host, entry.host) && (!entry.path || path.startsWith(entry.path)))?.name;
  return { name: service ?? host.replace(/^www\./, ''), host, service };
}

/** "Uni Notices <notices@uni.example.edu>" → name and address; a bare address keeps itself as the name. */
export function splitSender(sender: string): { name: string; address: string } {
  const match = sender.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match && match[1]) return { name: match[1].trim(), address: match[2].trim() };
  const address = (match ? match[2] : sender).trim();
  return { name: address, address: match ? address : '' };
}

function isEnglish(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, '').length;
  if (letters < 40) return false;
  const turkish = (text.match(TURKISH) ?? []).length;
  const words = (text.match(ENGLISH_WORDS) ?? []).length;
  return turkish / letters < 0.004 && words >= 3;
}

function isTurkish(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, '').length;
  return letters > 0 && (text.match(TURKISH) ?? []).length / letters >= 0.01;
}

function blocksOf(paragraph: string): Block[] {
  const lines = paragraph.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  if (lines.every((line) => SEPARATOR.test(line))) return [{ kind: 'divider' }];

  const links: Block[] = [];
  const seen = new Set<string>();
  const rest: string[] = [];
  for (const line of lines) {
    const urls = line.match(URL) ?? [];
    // The server writes a link's real target after its words: "Başvuru formu (https://…)".
    const left = line.replace(URL, '').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
    // "Başvuru formu: https://…" names its link; "Link: https://…" says nothing and is dropped.
    // A short line that is only words plus one link names that link: "Başvuru Sistemi: TYBS (https://…)".
    const caption = urls.length === 1 && left.length <= 80 && !/[.!?]$/.test(left) ? left.replace(/:$/, '').trim() : '';
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      const found = linkName(url);
      const useful = caption && !GENERIC_CAPTION.test(caption);
      links.push({ kind: 'link', url, host: found.host, service: found.service, name: useful ? caption : found.name });
    }
    if (left && !(urls.length && (caption || /^[\p{P}\s]*$/u.test(left)))) rest.push(left);
  }

  if (rest.length === 0) return links;
  if (rest.length > 1 && rest.every((line) => BULLET.test(line))) {
    return [{ kind: 'bullets', items: rest.map((line) => line.replace(BULLET, '')) }, ...links];
  }
  const text = rest.join('\n');
  const label = rest.length === 1 && text.length <= 60 && /[:：]$/.test(text);
  return [{ kind: 'paragraph', text, label }, ...links];
}

export function parseMail(body: string): MailText {
  const text = body.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  const paragraphs = text.split(/\n\s*\n/);

  // Quoted history: from the first "… wrote:" line, or the first run of "> " lines, to the end.
  let quoteAt = paragraphs.findIndex((p) => p.split('\n').some((line) => QUOTE_START.test(line.trim())) || /^>/.test(p.trim()));
  if (quoteAt === 0) quoteAt = -1;
  const own = quoteAt > 0 ? paragraphs.slice(0, quoteAt) : paragraphs;
  const quoted = quoteAt > 0 ? paragraphs.slice(quoteAt) : [];

  // Bilingual: Turkish first, then an English copy that opens after a separator or with "Dear …".
  let englishAt = -1;
  for (let i = 1; i < own.length; i += 1) {
    const before = own.slice(0, i).join('\n');
    const after = own.slice(i).join('\n');
    const opens = SEPARATOR.test(own[i - 1].trim()) || ENGLISH_OPENING.test(own[i].trim());
    if (opens && isTurkish(before) && isEnglish(after)) {
      englishAt = i;
      break;
    }
  }
  const turkish = englishAt > 0 ? own.slice(0, englishAt) : own;
  const english = englishAt > 0 ? own.slice(englishAt) : [];

  const build = (list: string[]) => markSignature(nameLinks(trimDividers(list.flatMap(blocksOf))));
  return { main: build(turkish), english: build(english), quoted: build(quoted.map((p) => p.replace(/^>\s?/gm, ''))) };
}

function trimDividers(blocks: Block[]): Block[] {
  const out = blocks.filter((block, i) => !(block.kind === 'divider' && blocks[i - 1]?.kind === 'divider'));
  while (out[0]?.kind === 'divider') out.shift();
  while (out[out.length - 1]?.kind === 'divider') out.pop();
  return out;
}

/** A short line right above a bare link names it: "06.11.2026 - Cuma - 15:00" then a Teams link becomes one card. */
function nameLinks(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const next = blocks[i + 1];
    // A date such as "6 November 2026 – Friday – 3.00 p.m." may end in a full stop; a sentence may not.
    const short = block.kind === 'paragraph' && !block.text.includes('\n') && block.text.length <= 60 &&
      (!/[,.]$/.test(block.text) || /\d/.test(block.text));
    const unnamed = next?.kind === 'link' && (next.name === next.host.replace(/^www\./, '') || next.name === next.service);
    if (short && unnamed && blocks[i + 2]?.kind !== 'link') {
      out.push({ ...next, name: block.text.replace(/:$/, '') });
      i += 1;
    } else {
      out.push(block);
    }
  }
  return out;
}

/** From the sign-off ("Saygılarımızla,") on, paragraphs are the sender's signature. */
function markSignature(blocks: Block[]): Block[] {
  const at = blocks.findIndex((block) => block.kind === 'paragraph' && CLOSING.test(block.text) && block.text.length <= 40);
  if (at < 0 || at < blocks.length - 6) return blocks;
  return blocks.map((block, i) => (i >= at && block.kind === 'paragraph' ? { ...block, signature: true } : block));
}

export type LinkRisk = { level: 'school' | 'outside' | 'suspicious'; reason: string };

/** How careful to be before opening a link. Only the real host counts, never the words around it. */
export function linkRisk(url: string): LinkRisk {
  let parsed: globalThis.URL;
  try {
    parsed = new globalThis.URL(url);
  } catch {
    return { level: 'suspicious', reason: 'Adres okunamıyor.' };
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.username || parsed.password || /@/.test(url.split('/')[2] ?? '')) {
    return { level: 'suspicious', reason: 'Adresin içinde gizlenmiş bir kullanıcı adı var: asıl gideceği yer farklı.' };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) {
    return { level: 'suspicious', reason: 'Alan adı yerine çıplak bir IP adresi.' };
  }
  if (host.split('.').some((label) => label.startsWith('xn--'))) {
    return { level: 'suspicious', reason: 'Alan adı başka harflerle taklit edilmiş olabilir (punycode).' };
  }
  if (parsed.protocol !== 'https:') {
    return { level: 'suspicious', reason: 'Şifresiz (http) bağlantı.' };
  }
  const school = appConfig().schoolDomain;
  if (school && onDomain(host, school)) return { level: 'school', reason: '' };
  return { level: 'outside', reason: school ? 'Okul dışına gidiyor.' : 'Bu bağlantı dışarıya gidiyor.' };
}
