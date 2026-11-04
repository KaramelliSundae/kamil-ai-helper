/**
 * The phone mode's secrets and choices, in Android's encrypted storage (expo-secure-store), never in the
 * data file and never sent anywhere except to Canvas and to Google.
 */
import * as SecureStore from 'expo-secure-store';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

const KEYS = {
  canvasUrl: 'phone.canvasUrl',
  canvasToken: 'phone.canvasToken',
  geminiKey: 'phone.geminiKey',
  geminiModel: 'phone.geminiModel',
} as const;

export type PhoneSettings = { canvasUrl: string; canvasToken: string; geminiKey: string; geminiModel: string };

export async function loadPhoneSettings(): Promise<PhoneSettings> {
  const [canvasUrl, canvasToken, geminiKey, geminiModel] = await Promise.all([
    SecureStore.getItemAsync(KEYS.canvasUrl),
    SecureStore.getItemAsync(KEYS.canvasToken),
    SecureStore.getItemAsync(KEYS.geminiKey),
    SecureStore.getItemAsync(KEYS.geminiModel),
  ]);
  return {
    canvasUrl: canvasUrl ?? '',
    canvasToken: canvasToken ?? '',
    geminiKey: geminiKey ?? '',
    geminiModel: geminiModel || DEFAULT_GEMINI_MODEL,
  };
}

export async function savePhoneSettings(settings: PhoneSettings): Promise<void> {
  await SecureStore.setItemAsync(KEYS.canvasUrl, settings.canvasUrl);
  await SecureStore.setItemAsync(KEYS.canvasToken, settings.canvasToken);
  await SecureStore.setItemAsync(KEYS.geminiKey, settings.geminiKey);
  await SecureStore.setItemAsync(KEYS.geminiModel, settings.geminiModel || DEFAULT_GEMINI_MODEL);
}

export async function clearPhoneSettings(): Promise<void> {
  await Promise.all(Object.values(KEYS).map((key) => SecureStore.deleteItemAsync(key)));
}

/** "canvas.uni.edu" for "https://canvas.uni.edu/", or "" when the address is not a usable https URL. */
export function canvasHost(url: string): string {
  const match = url.trim().match(/^https:\/\/([^/?#:@]+)(?::\d+)?\/?$/i);
  return match ? match[1].toLowerCase() : '';
}
