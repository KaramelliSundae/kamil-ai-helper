/**
 * Canvas from the phone, read-only. A personal access token carries all of the account's rights,
 * including submitting work, so this client only ever sends GET. It follows pagination only within the
 * Canvas host, because the token goes with every request. Mirrors ai_ders/canvas.py.
 */
import { htmlToText } from './text';

const PER_PAGE = 100;
const MAX_PAGES = 50;
const TIMEOUT_MS = 30_000;
const SUBMITTED = new Set(['submitted', 'pending_review', 'graded']);
const PLANNER_KINDS: Record<string, string> = { quiz: 'quiz', discussion_topic: 'discussion', calendar_event: 'event' };
const ANNOUNCEMENT_DAYS = 30;
const PLANNER_DAYS = 60;

export class CanvasError extends Error {}
export class CanvasAuthError extends CanvasError {}

export type CanvasItem = {
  key: string;
  kind: string;
  title: string;
  course: string;
  url: string;
  sender: string;
  body: string;
  dueAt: string | null;
  postedAt: string | null;
  grade: string | null;
  submitted: boolean;
};

type Creds = { url: string; token: string };
type Row = Record<string, any>;

function query(params: Record<string, string | number | string[]>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(one))}`);
    }
  }
  return parts.join('&');
}

function nextLink(header: string | null): string | null {
  for (const part of (header ?? '').split(',')) {
    const [target, ...sections] = part.split(';');
    if (sections.some((section) => section.trim() === 'rel="next"')) return target.trim().replace(/^<|>$/g, '');
  }
  return null;
}

function origin(url: string): string {
  const match = url.match(/^(https:\/\/[^/?#]+)/i);
  return match ? match[1].toLowerCase() : '';
}

async function get(creds: Creds, url: string): Promise<{ body: any; link: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${creds.token}` }, signal: controller.signal });
  } catch {
    throw new CanvasError("Canvas'a ulaşılamıyor");
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401) throw new CanvasAuthError('Canvas token geçersiz veya süresi dolmuş');
  if (response.status >= 400) throw new CanvasError(`Canvas hata verdi (${response.status})`);
  return { body: await response.json(), link: response.headers.get('Link') };
}

async function list(creds: Creds, path: string, params: Record<string, string | number | string[]> = {}): Promise<Row[]> {
  const base = creds.url.replace(/\/+$/, '');
  const home = origin(base);
  let url: string | null = `${base}${path}?${query({ per_page: PER_PAGE, ...params })}`;
  const rows: Row[] = [];
  for (let page = 1; url; page += 1) {
    if (page > MAX_PAGES) throw new CanvasError(`Canvas ${path} için ${MAX_PAGES} sayfadan fazla döndü`);
    const { body, link }: { body: any; link: string | null } = await get(creds, url);
    if (Array.isArray(body)) rows.push(...body);
    url = nextLink(link);
    if (url && origin(url) !== home) throw new CanvasError('Canvas başka bir adrese yönlendirdi, durduruldu');
  }
  return rows;
}

export async function profile(creds: Creds): Promise<{ name: string; email: string }> {
  const { body } = await get(creds, `${creds.url.replace(/\/+$/, '')}/api/v1/users/self/profile`);
  return { name: body?.short_name || body?.name || '', email: body?.primary_email || body?.login_id || '' };
}

async function courses(creds: Creds): Promise<Map<number, string>> {
  const rows = await list(creds, '/api/v1/courses', { enrollment_state: 'active' });
  // A course the student cannot open yet comes back with only an id and a restriction flag.
  return new Map(rows.filter((r) => !r.access_restricted_by_date).map((r) => [r.id as number, (r.name as string) || String(r.id)]));
}

function assignmentItem(row: Row, course: string): CanvasItem {
  const submission = row.submission ?? {};
  const isQuiz = (row.submission_types ?? []).includes('online_quiz') || !!row.is_quiz_assignment;
  const graded = submission.workflow_state === 'graded' && submission.grade != null;
  // Quizzes and graded discussions also appear in the planner under their own id; sharing that key
  // means one task never produces two reminders.
  const key = row.quiz_id ? `quiz:${row.quiz_id}` : row.discussion_topic?.id ? `discussion:${row.discussion_topic.id}` : `assignment:${row.id}`;
  return {
    key,
    kind: isQuiz ? 'quiz' : 'assignment',
    title: row.name || '(adsız)',
    course,
    url: row.html_url || '',
    sender: '',
    body: htmlToText(row.description),
    dueAt: row.due_at || null,
    postedAt: row.created_at || null,
    grade: graded ? String(submission.grade) : null,
    submitted: SUBMITTED.has(submission.workflow_state) || !!submission.submitted_at,
  };
}

/** Everything the watcher looks at, newest records winning when a task is listed twice. */
export async function fetchCanvas(creds: Creds, now: Date): Promise<CanvasItem[]> {
  const byId = await courses(creds);
  const items: CanvasItem[] = [];
  for (const [id, name] of byId) {
    for (const row of await list(creds, `/api/v1/courses/${id}/assignments`, { 'include[]': 'submission' })) {
      items.push(assignmentItem(row, name));
    }
  }
  if (byId.size) {
    const start = new Date(now.getTime() - ANNOUNCEMENT_DAYS * 864e5).toISOString();
    const rows = await list(creds, '/api/v1/announcements', {
      'context_codes[]': [...byId.keys()].map((id) => `course_${id}`),
      start_date: start,
      end_date: now.toISOString(),
    });
    for (const row of rows) {
      const code: string = row.context_code ?? '';
      const courseId = code.startsWith('course_') ? Number(code.split('_')[1]) : 0;
      items.push({
        key: `announcement:${row.id}`,
        kind: 'announcement',
        title: row.title || '(başlıksız)',
        course: byId.get(courseId) ?? '',
        url: row.html_url || '',
        sender: row.user_name || row.author?.display_name || '',
        body: htmlToText(row.message),
        dueAt: null,
        postedAt: row.posted_at || null,
        grade: null,
        submitted: false,
      });
    }
  }
  const planned = await list(creds, '/api/v1/planner/items', {
    start_date: new Date(now.getTime() - 864e5).toISOString(),
    end_date: new Date(now.getTime() + PLANNER_DAYS * 864e5).toISOString(),
  });
  for (const row of planned) {
    const kind = PLANNER_KINDS[row.plannable_type ?? ''];
    if (!kind) continue;
    items.push({
      key: `${kind}:${row.plannable_id}`,
      kind,
      title: row.plannable?.title || '(başlıksız)',
      course: row.context_name || byId.get(row.course_id ?? 0) || '',
      url: row.html_url || '',
      sender: '',
      body: '',
      dueAt: row.plannable_date || null,
      postedAt: null,
      grade: null,
      submitted: typeof row.submissions === 'object' && row.submissions ? !!row.submissions.submitted : false,
    });
  }
  // Listing conversations does not mark them read; only opening one does.
  const { body: conversations } = await get(creds, `${creds.url.replace(/\/+$/, '')}/api/v1/conversations?per_page=30`);
  for (const row of Array.isArray(conversations) ? conversations : []) {
    if (row.last_message_at === row.last_authored_message_at) continue; // the student's own reply is not news
    items.push({
      key: `message:${row.id}:${row.last_message_at}`,
      kind: 'message',
      title: row.subject || '(konusuz)',
      course: row.context_name || '',
      url: '',
      sender: (row.participants ?? []).slice(0, 3).map((p: Row) => p.name ?? '').join(', '),
      body: row.last_message || '',
      dueAt: null,
      postedAt: row.last_message_at || null,
      grade: null,
      submitted: false,
    });
  }
  // Assignments came first, so a task also in the planner keeps its fuller record.
  const merged = new Map<string, CanvasItem>();
  for (const item of [...items].reverse()) merged.set(item.key, item);
  return [...merged.values()];
}
