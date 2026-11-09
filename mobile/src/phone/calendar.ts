/**
 * Events from a mail on the phone. With the Google account connected the event goes straight into Google Calendar; without
 * it, or when Google refuses, Android's own calendar app opens with the event filled in and the student saves it there.
 * Either way only an event the student picked is ever added. Mirrors ai_ders/gcalendar.py.
 */
import * as IntentLauncher from 'expo-intent-launcher';

import type { CalendarOption } from '../types';
import { ApiError } from '../types';
import { google, localDay, SCOPE, token } from './tasks';
import { loadCalendarStatus, loadGoogleConnected, saveCalendarStatus, saveGoogleConnected } from './settings';
import { cleanEvent } from './suggest';
import { readState, updateState } from './store';

const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const DEFAULT_MINUTES = 60;
const DAY_MS = 864e5;

const dayOf = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const plusDay = (day: string, days: number) => new Date(dayOf(day) + days * DAY_MS).toISOString().slice(0, 10);

function localTime(start: string): Date {
  return new Date(`${start}:00`); // no zone given: this phone's own
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function localIso(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

function googleBody(event: CalendarOption, notes: string) {
  const body: Record<string, unknown> = { summary: event.title, ...(event.location ? { location: event.location } : {}), ...(notes ? { description: notes } : {}) };
  if (event.start.length === 10) {
    body.start = { date: event.start };
    body.end = { date: plusDay(event.end ?? event.start, 1) }; // Google's end day is exclusive
  } else {
    const begin = localTime(event.start);
    const finish = event.end ? localTime(event.end) : new Date(begin.getTime() + DEFAULT_MINUTES * 60_000);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    body.start = { dateTime: localIso(begin), timeZone };
    body.end = { dateTime: localIso(finish), timeZone };
  }
  return body;
}

/** Android's calendar app, opened with the event filled in. The student saves it; Kamil never sees whether they did. */
export async function openInCalendar(event: CalendarOption, notes = ''): Promise<void> {
  const allDay = event.start.length === 10;
  const begin = allDay ? dayOf(event.start) : localTime(event.start).getTime();
  const finish = allDay
    ? dayOf(event.end ?? event.start) + DAY_MS
    : event.end ? localTime(event.end).getTime() : begin + DEFAULT_MINUTES * 60_000;
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.INSERT', {
      data: 'content://com.android.calendar/events',
      extra: {
        title: event.title,
        beginTime: begin,
        endTime: finish,
        allDay,
        ...(event.location ? { eventLocation: event.location } : {}),
        ...(notes ? { description: notes } : {}),
      },
    });
  } catch {
    throw new ApiError('Takvim uygulaması açılamadı.', 502);
  }
}

/**
 * The one Google connection: a single permission screen for Tasks and the calendar together. It asks for the right to add
 * tasks and events only; nothing is read. A student who connected Tasks before comes back here to add the calendar.
 */
export async function connectGoogleAll(): Promise<void> {
  const before = await loadCalendarStatus();
  try {
    await token(`${SCOPE} ${CALENDAR_SCOPE}`);
  } catch (reason) {
    // A refusal only counts against the calendar if it was in use; someone who never connected has nothing to mark.
    if (before === 'ok' || (await loadGoogleConnected())) await saveCalendarStatus('failed');
    throw reason;
  }
  await saveGoogleConnected(true);
  await saveCalendarStatus('ok');
}

export async function addEvent(key: string, option: CalendarOption): Promise<{ status: string }> {
  const state = await readState();
  const row = state.items[key];
  if (!row) throw new ApiError('kayıt bulunamadı', 404);
  const event = cleanEvent(option, localDay(new Date().toISOString()));
  if (!event) throw new ApiError('Etkinliğin adı ve günü geçerli olmalı, bağlantı içermemeli', 422);
  const marker = `${key}|${event.title}|${event.start}`;
  if (state.meta.gcal?.[marker]) return { status: 'exists' };
  const notes = `Kamil: ${row.course ? `${row.course}: ${row.title}` : row.title}`;
  const calendar = await loadCalendarStatus();
  // A student who connected Tasks is tried once without asking again; one who never connected, or switched it off, is not.
  const direct = calendar === 'ok' || (calendar === '' && (await loadGoogleConnected()));
  if (direct) {
    try {
      const response = await google('POST', EVENTS_URL, googleBody(event, notes), CALENDAR_SCOPE);
      if (response.ok) {
        const { id } = await response.json();
        await updateState((saved) => {
          saved.meta.gcal = { ...saved.meta.gcal, [marker]: id };
        });
        if (calendar !== 'ok') await saveCalendarStatus('ok');
        return { status: 'added' };
      }
    } catch {
      // Not allowed, cancelled, or the Calendar API is closed: handled below like a refusal.
    }
    // Remembered, so the next event goes straight to the calendar app and Ayarlar offers to connect again.
    await saveCalendarStatus('failed');
    await openInCalendar(event, notes);
    return { status: 'reconnect' };
  }
  await openInCalendar(event, notes);
  return { status: 'opened' };
}
