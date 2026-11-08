/**
 * Tasks on the phone. Android has no documented way for an app to add to Google Tasks by itself, so there are two roads.
 * With nothing set up, the task goes through Android's share sheet and the student picks Tasks, Keep or anything else.
 * With the Google account connected (docs/google-tasks.md), it goes straight in, with its date, and a date that changes
 * later can be followed. Android hands out a token good for an hour: no client secret and no refresh token on the phone.
 */
import { Share } from 'react-native';

import { shortDay } from '../format';
import { ApiError } from '../types';
import { clearGoogleToken, googleAccessToken, googleProblem } from '../../modules/google-auth';
import { loadGoogleConnected, saveGoogleConnected } from './settings';
import { cleanTitle } from './suggest';
import { PhoneState, readState, updateState } from './store';

const TASKS_URL = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';
const SCOPE = 'https://www.googleapis.com/auth/tasks';

async function token(): Promise<string> {
  try {
    const access = await googleAccessToken(SCOPE);
    if (access) return access;
  } catch (reason) {
    throw new ApiError(googleProblem(reason), 502);
  }
  throw new ApiError("Google'a bağlanılamadı.", 502);
}

/** The first thing asked of a new connection: it opens Google's own permission screen. */
export async function connectGoogle(): Promise<void> {
  await token();
  await saveGoogleConnected(true);
}

async function google(method: string, url: string, body?: unknown): Promise<Response> {
  const send = (access: string) => fetch(url, {
    method,
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const access = await token();
  try {
    const response = await send(access);
    if (response.status !== 401) return response;
    // A cached token that has stopped working: once more with a fresh one.
    await clearGoogleToken(access).catch(() => undefined);
    return await send(await token());
  } catch (reason) {
    if (reason instanceof ApiError) throw reason;
    throw new ApiError("Google Tasks'a ulaşılamadı", 502);
  }
}

const dueField = (day: string) => `${day}T00:00:00.000Z`; // Google keeps only the date

/** 2026-11-14 in this phone's own time. */
export function localDay(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

type Source = { day: string | null; title: string; notes: string; origin: string; url: string; exam: boolean };

export function examTask(exam: { course: string; kind: string; number: number; status: string; week: number | null; url: string }): { title: string; notes: string } {
  const name = (exam.kind === 'midterm' ? 'Vize' : exam.kind === 'final' ? 'Final' : 'Quiz') + (exam.number ? ` ${exam.number}` : '');
  const guessed = exam.status === 'estimated';
  const week = guessed ? `Tahmini tarih: ${exam.week}. hafta. Kesinleşince kontrol et.` : '';
  return { title: `${exam.course}: ${name}${guessed ? ' (tahmini)' : ''}`, notes: [week, exam.url].filter(Boolean).join('\n') };
}

function sourceOf(state: PhoneState, key: string): Source | null {
  const exam = state.exams?.[key];
  if (exam) {
    const task = examTask(exam);
    return { day: exam.startsOn, title: task.title, notes: task.notes, origin: task.title, url: exam.url, exam: true };
  }
  const item = state.items[key];
  if (!item) return null;
  const origin = item.course ? `${item.course}: ${item.title}` : item.title;
  return { day: item.dueAt ? localDay(item.dueAt) : null, title: origin, notes: item.url, origin, url: item.url, exam: false };
}

export async function addTask(key: string, choice?: { title: string; due?: string | null }): Promise<{ status: string }> {
  const state = await readState();
  if (state.meta.gtasks?.[key]) return { status: 'exists' };
  const source = sourceOf(state, key);
  if (!source) throw new ApiError('kayıt bulunamadı', 404);
  let { title, notes, day } = source;
  if (choice) {
    title = cleanTitle(choice.title);
    if (!title) throw new ApiError('Görev metni boş olamaz, bağlantı da içeremez', 422);
    notes = [source.origin, source.url].filter(Boolean).join('\n');
    day = choice.due ?? day;
  }
  if (!(await loadGoogleConnected())) {
    await Share.share({ message: day ? `${title}\nTarih: ${shortDay(day)}` : title });
    return { status: 'shared' };
  }
  const response = await google('POST', TASKS_URL, { title, notes, ...(day ? { due: dueField(day) } : {}) });
  if (!response.ok) throw new ApiError("Google Tasks'a eklenemedi", 502);
  const { id } = await response.json();
  await updateState((saved) => {
    saved.meta.gtasks = { ...saved.meta.gtasks, [key]: { id, due: choice?.due ? null : day } };
  });
  return { status: 'added' };
}

export async function removeTask(key: string): Promise<{ status: string }> {
  const state = await readState();
  const task = state.meta.gtasks?.[key];
  if (!task) return { status: 'absent' };
  if (await loadGoogleConnected()) {
    const response = await google('DELETE', `${TASKS_URL}/${encodeURIComponent(task.id)}`);
    if (!response.ok && response.status !== 404 && response.status !== 410) throw new ApiError("Google Tasks'tan çıkarılamadı", 502);
  }
  await forget(key);
  return { status: 'removed' };
}

async function forget(key: string): Promise<void> {
  await updateState((saved) => {
    if (saved.meta.gtasks) delete saved.meta.gtasks[key];
  });
}

export function outdatedTasks(state: PhoneState, today: string): { key: string; title: string; from: string; to: string }[] {
  const found = [];
  for (const [key, task] of Object.entries(state.meta.gtasks ?? {})) {
    const source = sourceOf(state, key);
    if (task.due && source?.day && source.day >= today && source.day !== task.due) {
      found.push({ key, title: source.title, from: task.due, to: source.day });
    }
  }
  return found;
}

export async function updateTask(key: string): Promise<{ status: string }> {
  const state = await readState();
  const task = state.meta.gtasks?.[key];
  const source = sourceOf(state, key);
  if (!task || !source?.day || !(await loadGoogleConnected())) throw new ApiError('görev bulunamadı', 404);
  // An exam's name can change with its date ("tahmini" goes away). An item keeps the wording the student chose.
  const words = source.exam ? { title: source.title, notes: source.notes } : {};
  const response = await google('PATCH', `${TASKS_URL}/${encodeURIComponent(task.id)}`, { due: dueField(source.day), ...words });
  if (response.status === 404 || response.status === 410) {
    await forget(key);
    return { status: 'gone' };
  }
  if (!response.ok) throw new ApiError("Google Tasks'a ulaşılamadı", 502);
  await updateState((saved) => {
    if (saved.meta.gtasks?.[key]) saved.meta.gtasks[key].due = source.day;
  });
  return { status: 'updated' };
}

export async function keepTask(key: string): Promise<{ status: string }> {
  const state = await readState();
  const source = sourceOf(state, key);
  if (!state.meta.gtasks?.[key] || !source?.day) throw new ApiError('görev bulunamadı', 404);
  await updateState((saved) => {
    if (saved.meta.gtasks?.[key]) saved.meta.gtasks[key].due = source.day;
  });
  return { status: 'kept' };
}
