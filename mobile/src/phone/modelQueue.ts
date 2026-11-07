/**
 * Every model call on the phone goes through here. A per-minute limit does not lose the work: it waits its turn, and a notification
 * says what waits and until when, then how it ended. A per-day limit cannot be waited out, so what is left stops and a notification
 * says so at once. The queue lives in memory, so closing the app drops what is waiting: the syllabus reading goes on by itself later.
 */
import * as Notifications from 'expo-notifications';

import { RateLimited } from './gemini';

export const CHANNEL_QUEUE = 'kamil-queue';
const STATUS_ID = 'kamil-model-queue';
const DAILY_ID = 'kamil-model-daily';
const WINDOW_MS = 60_000;
const DEFAULT_WAIT_MS = 60_000;
const MOST_TRIES = 5;
const DAY_FULL_MS = 3600_000; // Google does not say when a day ends for this quota, so a look once an hour

export type QueueNote = { id: 'status' | 'daily'; title: string; body: string; ongoing: boolean };
type Task = { label: string; model: string; perMinute: number; low: boolean; tries: number; run: () => Promise<unknown>; resolve: (value: any) => void; reject: (reason: unknown) => void };

export function createModelQueue(
  notify: (note: QueueNote) => void,
  { minWaitMs = 5000, concurrency = 2, windowMs = WINDOW_MS, defaultWaitMs = DEFAULT_WAIT_MS, now = () => Date.now() } = {},
) {
  const tasks: Task[] = [];
  const starts = new Map<string, number[]>();
  const dayFull = new Map<string, { until: number; error: RateLimited }>();
  let running = 0;
  let pausedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waitingUntil = 0;
  let showing = false;
  let lastText = '';
  let done = 0;
  let failed: string[] = [];

  const clock = (at: number) => new Date(at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

  function say() {
    if (waitingUntil && tasks.length) {
      const labels = [...new Set(tasks.map((task) => task.label))].join(', ');
      const body = `${tasks.length} iş sırada: ${labels}. Yaklaşık ${clock(waitingUntil)} civarında sürecek.`;
      showing = true;
      if (body !== lastText) {
        lastText = body;
        notify({ id: 'status', title: 'Dakikalık sınır doldu', body, ongoing: true });
      }
    } else if (showing && !tasks.length && !running) {
      const parts = [`${done} iş bitti`, ...(failed.length ? [`${failed.length} iş yapılamadı: ${[...new Set(failed)].join(', ')}`] : [])];
      notify({ id: 'status', title: 'Sıradaki işler bitti', body: `${parts.join(', ')}.`, ongoing: false });
      showing = false;
      lastText = '';
      done = 0;
      failed = [];
    } else if (!showing && !tasks.length && !running) {
      done = 0;
      failed = [];
    }
  }

  /** When the next task may start, 0 if now. */
  function gate(task: Task): number {
    const at = now();
    if (at < pausedUntil) return pausedUntil;
    const recent = (starts.get(task.model) ?? []).filter((time) => at - time < windowMs);
    starts.set(task.model, recent);
    return recent.length >= task.perMinute ? recent[0] + windowMs : 0;
  }

  function pump() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    waitingUntil = 0;
    while (tasks.length && running < concurrency) {
      const until = gate(tasks[0]);
      if (until) {
        waitingUntil = until;
        timer = setTimeout(pump, Math.max(until - now(), 50));
        break;
      }
      const task = tasks.shift()!;
      starts.get(task.model)?.push(now());
      running += 1;
      void execute(task);
    }
    say();
  }

  function stopForTheDay(task: Task, error: RateLimited) {
    dayFull.set(task.model, { until: now() + DAY_FULL_MS, error });
    const dropped = tasks.filter((other) => other.model === task.model);
    for (const other of dropped) {
      tasks.splice(tasks.indexOf(other), 1);
      other.reject(error);
      failed.push(other.label);
    }
    const left = dropped.length ? ` Bekleyen ${dropped.length} iş yapılamadı.` : '';
    notify({
      id: 'daily',
      title: 'Günlük sınır doldu',
      body: `${task.model}${error.limit ? ` (${error.limit})` : ''} bugünlük bitti.${left} Yarın sürer, ya da Ayarlar'dan başka bir model seçebilirsin.`,
      ongoing: false,
    });
  }

  async function execute(task: Task) {
    try {
      task.resolve(await task.run());
      done += 1;
    } catch (error) {
      if (error instanceof RateLimited && error.scope === 'minute' && task.tries + 1 < MOST_TRIES) {
        task.tries += 1;
        tasks.unshift(task);
        pausedUntil = Math.max(pausedUntil, now() + Math.max(error.retryMs ?? defaultWaitMs, minWaitMs));
      } else {
        if (error instanceof RateLimited && error.scope === 'day') stopForTheDay(task, error);
        task.reject(error);
        failed.push(task.label);
      }
    } finally {
      running -= 1;
      pump();
    }
  }

  return function queued<T>(label: string, model: string, perMinute: number, run: () => Promise<T>, low = false): Promise<T> {
    const full = dayFull.get(model);
    if (full && now() < full.until) return Promise.reject(full.error);
    if (full) dayFull.delete(model);
    return new Promise<T>((resolve, reject) => {
      const task: Task = { label, model, perMinute, low, tries: 0, run, resolve, reject };
      // What the student is waiting for goes ahead of what happens by itself.
      const at = low ? -1 : tasks.findIndex((other) => other.low);
      if (at < 0) tasks.push(task);
      else tasks.splice(at, 0, task);
      pump();
    });
  };
}

function show(note: QueueNote) {
  void Notifications.scheduleNotificationAsync({
    identifier: note.id === 'status' ? STATUS_ID : DAILY_ID,
    content: { title: note.title, body: note.body, sticky: note.ongoing },
    trigger: { channelId: CHANNEL_QUEUE },
  }).catch(() => undefined);
}

export const queued = createModelQueue(show);
