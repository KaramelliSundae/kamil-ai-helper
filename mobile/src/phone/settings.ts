/**
 * The phone mode's secrets and choices, in Android's encrypted storage (expo-secure-store), never in the
 * data file and never sent anywhere except to Canvas and to Google.
 */
import * as SecureStore from 'expo-secure-store';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
/** Older than the newest models, so it would fall off a short list, but kept on offer for its generous limits. */
export const GENEROUS_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const MODEL_CHOICES = 6;

/** The models to offer as shortcuts, newest first, out of those the key may call. */
export function modelChoices(models: string[]): string[] {
  const newest = models.slice(0, MODEL_CHOICES);
  if (!models.includes(GENEROUS_GEMINI_MODEL) || newest.includes(GENEROUS_GEMINI_MODEL)) return newest;
  return [...newest.slice(0, MODEL_CHOICES - 1), GENEROUS_GEMINI_MODEL];
}

const KEYS = {
  canvasUrl: 'phone.canvasUrl',
  canvasToken: 'phone.canvasToken',
  geminiKey: 'phone.geminiKey',
  geminiModel: 'phone.geminiModel',
  syllabusCheckDays: 'phone.syllabusCheckDays',
  mailHost: 'phone.mailHost',
  mailUser: 'phone.mailUser',
  mailPassword: 'phone.mailPassword',
  mailToGemini: 'phone.mailToGemini',
} as const;

/** Every file read is one Gemini request, so by default a course with no syllabus yet is looked at once a week. */
export const DEFAULT_SYLLABUS_CHECK_DAYS = 7;

export type PhoneSettings = { canvasUrl: string; canvasToken: string; geminiKey: string; geminiModel: string; syllabusCheckDays: number };

export async function loadPhoneSettings(): Promise<PhoneSettings> {
  const [canvasUrl, canvasToken, geminiKey, geminiModel, syllabusCheckDays] = await Promise.all([
    SecureStore.getItemAsync(KEYS.canvasUrl),
    SecureStore.getItemAsync(KEYS.canvasToken),
    SecureStore.getItemAsync(KEYS.geminiKey),
    SecureStore.getItemAsync(KEYS.geminiModel),
    SecureStore.getItemAsync(KEYS.syllabusCheckDays),
  ]);
  return {
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

/** "canvas.uni.edu" for "https://canvas.uni.edu/", or "" when the address is not a usable https URL. */
export function canvasHost(url: string): string {
  const match = url.trim().match(/^https:\/\/([^/?#:@]+)(?::\d+)?\/?$/i);
  return match ? match[1].toLowerCase() : '';
}
