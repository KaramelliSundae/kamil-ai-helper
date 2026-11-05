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
};
export type ServerJob = {
  id: string;
  label: string;
  gpu: boolean;
  status: string;
  note: string;
  finishedAt?: number | null;
};
export type Today = { upcoming: Upcoming[]; pendingDrafts: number; gpu: GpuState; tasksEnabled?: boolean };
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
export type GeminiSettings = { connected: boolean; source: 'server' | 'app' | null; model: string; mailAllowed: boolean };
export type Conversation = { id: number; title: string; updatedAt: string };
export type EventItem = {
  id: number;
  itemKey: string;
  type: string;
  level: string;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  /** The item as it is now; absent for events with no item behind them, such as alerts. */
  current?: { title: string; course: string; dueAt: string | null; submitted: boolean; grade: string | null } | null;
  /** Phone mode: already announced by an exact alarm, so the event list shows it without notifying again. */
  silent?: boolean;
};
export type ChatMessage = { id: number; role: 'user' | 'assistant'; content: string };
export type Release = { versionCode: number; versionName: string; sha256: string; size: number };
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

