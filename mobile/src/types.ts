/** Types shared by the server client (api.ts) and the phone-only backend (phone/). */

export type Upcoming = {
  key: string;
  kind: string;
  title: string;
  course: string;
  url: string;
  dueAt: string;
  inTasks?: boolean;
};
export type GpuState = {
  mode: string;
  /** The server this machine names. Compute opens it, and it stays up until AI-Asistan is chosen. */
  server?: { name: string; known: boolean; up: boolean; busy: boolean };
  llmActive: boolean;
  blocked: string | null;
  gateMissing?: boolean;
  /** What holds the GPU now: the model, a job, image work, or nothing. */
  gpuOwner?: 'kamil' | 'job' | 'image' | 'free';
  prioritySeconds?: number;
  keepOffSeconds?: number;
  jobs?: ServerJob[];
  system?: {
    ramAvailableGib?: number;
    ramTotalGib?: number;
    vramUsedMib?: number;
    vramTotalMib?: number;
    gpuTempC?: number;
    load?: number;
    cores?: number;
  };
  lastPollAt?: string | null;
  /** What this server calls its image program. */
  imageAppName?: string | null;
  /** What Kamil has done since midnight. */
  today?: { answers: number; notifications: number };
};
export type ServerJob = {
  id: string;
  label: string;
  gpu: boolean;
  /** Stays up until someone stops it, with no time limit. */
  server?: boolean;
  status: string;
  note: string;
  finishedAt?: number | null;
};
export type Exam = {
  key: string;
  course: string;
  kind: 'midterm' | 'final';
  number: number;
  startsOn: string;
  endsOn: string | null;
  /** announced: the teacher said so. syllabus: written there, may change. estimated: only the week is known. */
  status: 'announced' | 'syllabus' | 'estimated';
  week: number | null;
  source: string;
  evidence: string;
  url: string;
  inTasks?: boolean;
};
/** A task the model proposes from an announcement or a mail. Nothing is added until the student picks it. */
export type TaskOption = { title: string; due: string | null };
export type Today = {
  upcoming: Upcoming[];
  pendingDrafts: number;
  gpu: GpuState;
  tasksEnabled?: boolean;
  /** Older servers send neither of these. */
  exams?: Exam[];
  examsMissing?: { course: string; hint: string }[];
  /** The first read of every course's syllabus is still going on. */
  examsScanning?: boolean;
  examsScanProgress?: { done: number; total: number };
  /** Tasks whose item or exam has moved since they were added. Nothing changes until the student agrees. */
  tasksOutdated?: { key: string; title: string; from: string; to: string }[];
};
export type ItemDetail = {
  key: string;
  kind: string;
  title: string;
  course: string;
  sender: string;
  body: string;
  url: string;
  postedAt: string | null;
  dueAt: string | null;
  grade: string | null;
  submitted: boolean;
  inTasks?: boolean;
  /** Mail: the address a reply goes to. */
  replyTo?: string;
  /** Older servers send none. `image` is the hash of a JPEG the server's sandbox re-encoded. */
  attachments?: Attachment[];
};
export type Attachment = { name: string; type: string; size: number; image: string | null; width: number; height: number };
export type ModelId = 'local' | 'gemini';
export type ModelOption = { id: ModelId; name: string; detail: string };
export type ChatSetup = {
  firstName: string | null;
  models: ModelOption[];
  /** Newer servers and the phone backend: what this setup offers. */
  schoolDomain?: string;
  webmailUrl?: string;
  features?: { localModel: boolean; gpuGate: boolean; tasks: boolean };
};
export type GeminiSettings = { connected: boolean; source: 'server' | 'app' | null; model: string; mailAllowed: boolean; provider?: 'gemini' | 'openrouter' | 'custom'; baseUrl?: string };
export type Conversation = { id: number; title: string; updatedAt: string };
export type EventSource = 'canvas' | 'mail';
export type EventItem = {
  id: number;
  itemKey: string;
  type: string;
  level: string;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  /** Older servers send neither of these. */
  read?: boolean;
  source?: EventSource;
  /** The item as it is now; absent for events with no item behind them, such as alerts. */
  current?: { postedAt?: string | null; title: string; course: string; dueAt: string | null; submitted: boolean; grade: string | null } | null;
  /** Mail: the conversation, as its headers name it. Older servers send none, and the subject decides. */
  thread?: string;
  /** Mail the student sent: only a side of a conversation, never a row of its own. */
  outgoing?: boolean;
  /** Mail: it has attachments, and it came from the school's domain. */
  hasFiles?: boolean;
  fromSchool?: boolean;
  /** On a conversation's row: all its events, oldest first. */
  threadEvents?: EventItem[];
  /** Phone mode: already announced by an exact alarm, so the event list shows it without notifying again. */
  silent?: boolean;
};
export type ChatMessage = { id: number; role: 'user' | 'assistant'; content: string };
export type Release = { versionCode: number; versionName: string; sha256: string; size: number; source?: 'server' | 'github' };
export type Draft = {
  id: string;
  to: string;
  subject: string;
  body: string;
  hash: string;
  createdAt: string;
  /** Set by the server when the draft looks like a mail told Kamil to write it. */
  warnings?: string[];
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

