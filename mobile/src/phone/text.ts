/**
 * Text helpers for the phone backend, matching the server's ai_ders/text.py: HTML to readable text,
 * Turkish-aware lower case, and the "is this an edit or only a better rendering" fingerprint.
 *
 * Canvas sends descriptions and announcements as HTML. Only text is ever kept: no element is rendered,
 * no image or link is fetched.
 */

const SKIPPED = new Set(['script', 'style', 'head', 'title', 'template', 'noscript']);
const PARAGRAPH = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol', 'blockquote', 'hr', 'pre']);
const LINE = new Set(['div', 'tr', 'li', 'dt', 'dd', 'section', 'article', 'header', 'footer']);
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«',
  raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', middot: '·', copy: '©', reg: '®', euro: '€',
  ccedil: 'ç', Ccedil: 'Ç', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', iuml: 'ï', eacute: 'é', agrave: 'à',
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : '';
    }
    return NAMED[code] ?? whole;
  });
}

function hrefOf(attributes: string): string {
  const found = attributes.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return decode((found?.[2] ?? found?.[3] ?? found?.[4] ?? '').trim());
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const parts: string[] = [];
  let pending = 0;
  let skipping = 0;
  let bullet = false;
  const links: { href: string; start: number }[] = [];

  const breakLines = (lines: number) => {
    pending = Math.max(pending, lines);
  };
  const write = (text: string) => {
    if (pending && parts.length) {
      parts.push('\n'.repeat(pending));
      text = text.replace(/^ +/, '');
    }
    if (bullet) {
      text = `• ${text.replace(/^ +/, '')}`;
      bullet = false;
    }
    pending = 0;
    parts.push(text);
  };

  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)|</g;
  for (const match of html.matchAll(token)) {
    const [whole, closing, rawTag, attributes, data] = match;
    if (whole.startsWith('<!--')) continue;
    if (data !== undefined || whole === '<') {
      if (skipping) continue;
      const text = decode(data ?? whole).replace(/\s+/g, ' ');
      if (!text.trim()) {
        if (!pending && parts.length && !/[ \n]$/.test(parts[parts.length - 1])) parts.push(' ');
        continue;
      }
      write(text);
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (SKIPPED.has(tag)) {
      skipping = closing ? Math.max(0, skipping - 1) : skipping + 1;
      continue;
    }
    if (skipping) continue;
    if (closing) {
      if (PARAGRAPH.has(tag)) breakLines(2);
      else if (LINE.has(tag)) breakLines(1);
      else if (tag === 'a') {
        const link = links.pop();
        if (link) {
          const shown = parts.slice(link.start).join('').trim();
          // The real target stays next to the words, so a link cannot hide where it goes.
          if (/^https?:\/\//i.test(link.href) && shown && !shown.includes(link.href.replace(/\/$/, ''))) {
            parts.push(` (${link.href})`);
          }
        }
      }
      continue;
    }
    if (tag === 'br') pending = Math.min(pending + 1, 2);
    else if (tag === 'hr') {
      breakLines(2);
      write('———');
      breakLines(2);
    } else if (PARAGRAPH.has(tag)) breakLines(2);
    else if (LINE.has(tag)) {
      breakLines(1);
      if (tag === 'li') bullet = true;
    } else if (tag === 'td' || tag === 'th') parts.push(' ');
    else if (tag === 'a') links.push({ href: hrefOf(attributes), start: parts.length });
  }
  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Lower case with Turkish rules, so "İLAN" and "ilan" compare equal. */
export function normalizeTr(text: string): string {
  return text.replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase();
}

export function shorten(text: string, limit: number): string {
  const flat = text.split(/\s+/).filter(Boolean).join(' ');
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/** What counts as an edit: the words. Layout, bullets and written-out link targets are left out. */
export function fingerprint(text: string): string {
  return (text || '').replace(/\s*\(https?:\/\/[^\s)]*\)/g, '').replace(/[\s•—]+/g, '');
}
