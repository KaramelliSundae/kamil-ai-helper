/**
 * Turning the phone mode on: each secret is checked against the service it is for before it is kept,
 * then the first round learns what already exists without notifying anything.
 */
import { CanvasError, profile } from './canvas';
import { cleanBaseUrl, ModelOption, modelOptions } from './cloud';
import { GeminiError } from './gemini';
import { canvasHost, clearPhoneSettings, DEFAULT_GEMINI_MODEL, PhoneSettings, savePhoneSettings } from './settings';
import { clearState, readState, updateState } from './store';
import { poll } from './watcher';

export type SetupResult = { name: string; items: number; models: ModelOption[]; model: string };

/** Mail under this domain counts as the school's: the student's own address, else Canvas's host minus "canvas.". */
function schoolDomainOf(email: string, host: string): string {
  const fromEmail = email.includes('@') ? email.split('@').pop()!.toLowerCase() : '';
  if (fromEmail) return fromEmail;
  const labels = host.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : host;
}

export async function connectPhone(input: Omit<PhoneSettings, 'syllabusCheckDays'>): Promise<SetupResult> {
  const host = canvasHost(input.canvasUrl);
  if (!host) throw new Error("Canvas adresini yalnızca alan adıyla yaz, örneğin canvas.okulun.edu");
  const canvasUrl = `https://${host}`;
  const canvasToken = input.canvasToken.trim();
  let who: { name: string; email: string };
  try {
    who = await profile({ url: canvasUrl, token: canvasToken });
  } catch (error) {
    throw new Error(error instanceof CanvasError ? error.message : "Canvas'a bağlanılamadı");
  }
  let models: ModelOption[] = [];
  let model = input.geminiModel.trim();
  const geminiKey = input.geminiKey.trim();
  const baseUrl = input.provider === 'custom' ? cleanBaseUrl(input.baseUrl) : '';
  if (geminiKey) {
    if (baseUrl === null) throw new Error('Servis adresini https:// ile yaz.');
    try {
      models = await modelOptions({ provider: input.provider, key: geminiKey, baseUrl }, (await readState()).meta.quotaSeen);
    } catch (error) {
      throw new Error(error instanceof GeminiError ? error.message : 'Modele bağlanılamadı');
    }
    const ids = models.map((option) => option.id);
    const preferred = input.provider === 'gemini' && ids.includes(DEFAULT_GEMINI_MODEL) ? DEFAULT_GEMINI_MODEL : ids[0];
    if (ids.length && !ids.includes(model)) model = preferred;
  }
  await savePhoneSettings({ canvasUrl, canvasToken, provider: input.provider, baseUrl: baseUrl ?? '', geminiKey, geminiModel: model || DEFAULT_GEMINI_MODEL });
  await updateState((state) => {
    // Canvas often keeps names in capitals: "AYŞE YILMAZ" greets as "Ayşe".
    const first = who.name.split(/\s+/)[0] ?? '';
    state.meta.firstName = first ? first[0].toLocaleUpperCase('tr') + first.slice(1).toLocaleLowerCase('tr') : undefined;
    state.meta.schoolDomain = schoolDomainOf(who.email, host);
  });
  const first = await poll();
  if (first.error) throw new Error(first.error);
  return { name: who.name, items: first.items, models, model };
}

/** Removes the phone mode's secrets and everything it stored on this phone. */
export async function forgetPhone(): Promise<void> {
  await clearPhoneSettings();
  await clearState();
}
