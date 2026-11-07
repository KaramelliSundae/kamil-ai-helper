/**
 * Phone notifications without Firebase: every ~15 minutes Android wakes this task. With a server it asks
 * the server for new events; in the phone mode it first polls Canvas itself. New events become local
 * notifications. Imported from index.ts, because the task must be defined before Android starts it headless.
 */
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';

import { api, EventItem, loadConnection } from './api';
import { CHANNEL_DEFAULT, CHANNEL_URGENT } from './phone/watcher';
import { readState, updateState } from './phone/store';
import { poll } from './phone/watcher';

const TASK = 'ai-ders-events';
const SEEN_KEY = 'notifiedEvents';
const SEEN_LIMIT = 300;
const STALE_MS = 24 * 3600 * 1000;
// Same quiet hours as the server's default: only critical events between 00:00 and 08:00.
const QUIET_END_HOUR = 8;
const DIGEST_HOUR = 8;
const DIGEST_DAYS = 3;

export { CHANNEL_DEFAULT, CHANNEL_URGENT };

TaskManager.defineTask(TASK, async () => {
  try {
    await checkEvents();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function setUpChannels(): Promise<void> {
  await Notifications.setNotificationChannelAsync(CHANNEL_URGENT, {
    name: 'Acil: son saatler',
    importance: Notifications.AndroidImportance.MAX,
  });
  await Notifications.setNotificationChannelAsync(CHANNEL_DEFAULT, {
    name: 'Ödevler, duyurular, önemli mailler',
    importance: Notifications.AndroidImportance.HIGH,
  });
}

/** Starts the periodic check. Safe to call on every launch. */
export async function startBackgroundChecks(): Promise<void> {
  await setUpChannels();
  await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 15 });
}

export async function notificationsAllowed(): Promise<boolean> {
  return (await Notifications.getPermissionsAsync()).granted;
}

export async function askForNotifications(): Promise<boolean> {
  return (await Notifications.requestPermissionsAsync()).granted;
}

export async function sendTestNotification(): Promise<void> {
  await setUpChannels();
  await Notifications.scheduleNotificationAsync({
    content: { title: 'Kamil', body: 'Bildirimler çalışıyor.' },
    trigger: { channelId: CHANNEL_DEFAULT },
  });
}

async function loadSeen(key: string): Promise<number[] | null> {
  const raw = await SecureStore.getItemAsync(key);
  return raw ? (JSON.parse(raw) as number[]) : null;
}

/** What to do with an event the phone has not handled yet. */
export function decide(event: EventItem, now: Date): 'notify' | 'skip' | 'wait' {
  if (event.silent) return 'skip'; // an alarm already announced it
  if (now.getTime() - new Date(event.createdAt).getTime() > STALE_MS) return 'skip';
  if (event.level === 'critical') return 'notify';
  if (event.level !== 'high') return 'skip'; // normal and low events stay in the app
  return now.getHours() < QUIET_END_HOUR ? 'wait' : 'notify';
}

/** The server mails a daily digest. Without one, the first wake after this hour says the same in a notification. */
async function phoneDigest(now = new Date()): Promise<void> {
  if (now.getHours() < DIGEST_HOUR || !(await notificationsAllowed())) return;
  const day = now.toDateString();
  const state = await readState();
  if (state.meta.digestDay === day) return;
  const soon = Object.values(state.items).filter((item) => {
    const due = item.dueAt ? Date.parse(item.dueAt) : 0;
    return due >= now.getTime() && due < now.getTime() + DIGEST_DAYS * 864e5 && !item.submitted;
  }).length;
  const unread = state.events.filter((event) => event.read === false && event.type !== 'reminder').length;
  await updateState((saved) => {
    saved.meta.digestDay = day;
  });
  if (!soon && !unread) return;
  await Notifications.scheduleNotificationAsync({
    content: { title: 'Günün özeti', body: `${DIGEST_DAYS} gün içinde ${soon} teslim, ${unread} okunmamış bildirim.` },
    trigger: { channelId: CHANNEL_DEFAULT },
  });
}

/** Shows new events once each. The first run only learns what already exists, so it never floods. */
export async function checkEvents(): Promise<number> {
  const connection = await loadConnection();
  if (!connection) return 0;
  if (connection.mode === 'phone') {
    await poll(undefined, true).catch(() => undefined);
    await phoneDigest().catch(() => undefined);
  }
  const events = await api.events(connection);
  // The two modes number their events separately, so each keeps its own memory of what it showed.
  const seenKey = connection.mode === 'phone' ? `${SEEN_KEY}.phone` : SEEN_KEY;
  const seen = await loadSeen(seenKey);
  if (seen === null) {
    await SecureStore.setItemAsync(seenKey, JSON.stringify(events.map((event) => event.id).slice(0, SEEN_LIMIT)));
    return 0;
  }

  const known = new Set(seen);
  const handled: number[] = [];
  const now = new Date();
  let shown = 0;
  // Oldest first, so the newest notification ends up on top.
  for (const event of [...events].reverse()) {
    if (known.has(event.id)) continue;
    const verdict = decide(event, now);
    if (verdict === 'wait') continue; // shown after quiet hours
    if (verdict === 'notify' && (await notificationsAllowed())) {
      await Notifications.scheduleNotificationAsync({
        content: { title: event.title, body: event.body.slice(0, 240), data: { eventId: event.id } },
        trigger: { channelId: event.level === 'critical' ? CHANNEL_URGENT : CHANNEL_DEFAULT },
      });
      shown += 1;
    }
    handled.push(event.id);
  }
  if (handled.length) {
    await SecureStore.setItemAsync(seenKey, JSON.stringify([...handled.reverse(), ...seen].slice(0, SEEN_LIMIT)));
  }
  return shown;
}
