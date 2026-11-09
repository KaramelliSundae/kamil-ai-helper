/**
 * The phone mode's secrets and choices, in Android's encrypted storage (expo-secure-store), never in the
 * data file and never sent anywhere except to Canvas and to Google.
 */
import * as SecureStore from 'expo-secure-store';

import type { CloudConfig, Provider } from './cloud';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const KEYS = {
  canvasUrl: 'phone.canvasUrl',
  canvasToken: 'phone.canvasToken',
  geminiKey: 'phone.geminiKey',
  geminiModel: 'phone.geminiModel',
  provider: 'phone.provider',
  baseUrl: 'phone.baseUrl',
  googleConnected: 'phone.googleConnected',
  calendarStatus: 'phone.calendarStatus',
  syllabusCheckDays: 'phone.syllabusCheckDays',
  mailHost: 'phone.mailHost',
  mailUser: 'phone.mailUser',
  mailPassword: 'phone.mailPassword',
  mailToGemini: 'phone.mailToGemini',
} as const;

/** Every file read is one Gemini request, so by default a course with no syllabus yet is looked at once a week. */
export const DEFAULT_SYLLABUS_CHECK_DAYS = 7;

export type PhoneSettings = { canvasUrl: string; canvasToken: string; provider: Provider; baseUrl: string; geminiKey: string; geminiModel: string; syllabusCheckDays: number };

export async function loadPhoneSettings(): Promise<PhoneSettings> {
  const [canvasUrl, canvasToken, geminiKey, geminiModel, syllabusCheckDays, provider, baseUrl] = await Promise.all([
    SecureStore.getItemAsync(KEYS.canvasUrl),
    SecureStore.getItemAsync(KEYS.canvasToken),
    SecureStore.getItemAsync(KEYS.geminiKey),
    SecureStore.getItemAsync(KEYS.geminiModel),
    SecureStore.getItemAsync(KEYS.syllabusCheckDays),
    SecureStore.getItemAsync(KEYS.provider),
    SecureStore.getItemAsync(KEYS.baseUrl),
  ]);
  return {
    provider: (provider as Provider | null) ?? 'gemini',
    baseUrl: baseUrl ?? '',
    canvasUrl: canvasUrl ?? '',
    canvasToken: canvasToken ?? '',
    geminiKey: geminiKey ?? '',
    geminiModel: geminiModel || DEFAULT_GEMINI_MODEL,
    syllabusCheckDays: syllabusCheckDays === null ? DEFAULT_SYLLABUS_CHECK_DAYS : Number(syllabusCheckDays),
  };
}

export async function savePhoneSettings(settings: Omit<PhoneSettings, 'syllabusCheckDays'>): Promise<void> {
  await SecureStore.setItemAsync(KEYS.canvasUrl, settings.canvasUrl);
  await SecureStore.setItemAsync(KEYS.canvasToken, settings.canvasToken);
  await SecureStore.setItemAsync(KEYS.geminiKey, settings.geminiKey);
  await SecureStore.setItemAsync(KEYS.geminiModel, settings.geminiModel || DEFAULT_GEMINI_MODEL);
  await SecureStore.setItemAsync(KEYS.provider, settings.provider);
  await SecureStore.setItemAsync(KEYS.baseUrl, settings.baseUrl);
}

export function cloudConfig(settings: PhoneSettings): CloudConfig | null {
  if (!settings.geminiKey) return null;
  return { provider: settings.provider, key: settings.geminiKey, model: settings.geminiModel, baseUrl: settings.baseUrl };
}

/** Only whether the student connected: Android keeps the permission itself, and no token is stored here. */
export async function loadGoogleConnected(): Promise<boolean> {
  return (await SecureStore.getItemAsync(KEYS.googleConnected)) === 'yes';
}

export async function saveGoogleConnected(connected: boolean): Promise<void> {
  if (connected) await SecureStore.setItemAsync(KEYS.googleConnected, 'yes');
  else await SecureStore.deleteItemAsync(KEYS.googleConnected);
}

/**
 * Where the calendar permission stands, apart from Tasks: '' never tried (a student who connected Tasks is tried once, the
 * first time), 'ok' it worked or was just given, 'failed' Google refused it (not given, or the Calendar API is closed),
 * 'off' the student switched it off. Only 'ok' and a first try go to Google; otherwise the phone's calendar app opens.
 */
export type CalendarStatus = '' | 'ok' | 'failed' | 'off';

export async function loadCalendarStatus(): Promise<CalendarStatus> {
  const value = await SecureStore.getItemAsync(KEYS.calendarStatus);
  return value === 'ok' || value === 'failed' || value === 'off' ? value : '';
}

export async function saveCalendarStatus(status: CalendarStatus): Promise<void> {
  if (status) await SecureStore.setItemAsync(KEYS.calendarStatus, status);
  else await SecureStore.deleteItemAsync(KEYS.calendarStatus);
}

export async function saveSyllabusCheckDays(days: number): Promise<void> {
  await SecureStore.setItemAsync(KEYS.syllabusCheckDays, String(days));
}

/** School mail, if the student added it. It goes only to that mail server, and to Gemini only if `toGemini` is on. */
export type MailSettings = { host: string; user: string; password: string; toGemini: boolean };

export async function loadMailSettings(): Promise<MailSettings> {
  const [host, user, password, toGemini] = await Promise.all([
    SecureStore.getItemAsync(KEYS.mailHost),
    SecureStore.getItemAsync(KEYS.mailUser),
    SecureStore.getItemAsync(KEYS.mailPassword),
    SecureStore.getItemAsync(KEYS.mailToGemini),
  ]);
  return { host: host ?? '', user: user ?? '', password: password ?? '', toGemini: toGemini === 'yes' };
}

export async function saveMailAccount(host: string, user: string, password: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.mailHost, host);
  await SecureStore.setItemAsync(KEYS.mailUser, user);
  await SecureStore.setItemAsync(KEYS.mailPassword, password);
}

export async function saveMailToGemini(on: boolean): Promise<void> {
  await SecureStore.setItemAsync(KEYS.mailToGemini, on ? 'yes' : 'no');
}

export async function clearMailSettings(): Promise<void> {
  await Promise.all([KEYS.mailHost, KEYS.mailUser, KEYS.mailPassword, KEYS.mailToGemini].map((key) => SecureStore.deleteItemAsync(key)));
}

export async function clearPhoneSettings(): Promise<void> {
  await Promise.all(Object.values(KEYS).map((key) => SecureStore.deleteItemAsync(key)));
}

/** "canvas.uni.edu" for "canvas.uni.edu" or "https://canvas.uni.edu/". "" when it is not a plain host, or asks for plain http. */
export function canvasHost(url: string): string {
  const match = url.trim().match(/^(?:https:\/\/)?([^/?#:@\s]+\.[^/?#:@\s]+)(?::\d+)?\/?$/i);
  return match ? match[1].toLowerCase() : '';
}
