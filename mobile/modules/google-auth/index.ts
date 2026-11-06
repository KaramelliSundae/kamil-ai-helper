/** The native side of the Google permission: see GoogleAuthModule.kt. */
import { requireNativeModule } from 'expo';

type GoogleAuthModule = {
  authorize(scope: string): Promise<string | null>;
  clearToken(token: string): Promise<void>;
};

/** Looked up when used rather than on import: without the native side only this fails, not the whole app. */
const native = () => requireNativeModule<GoogleAuthModule>('GoogleAuth');

export const googleAccessToken = (scope: string) => native().authorize(scope);
export const clearGoogleToken = (token: string) => native().clearToken(token);

export function googleProblem(reason: unknown): string {
  switch ((reason as { code?: string } | null)?.code) {
    case 'ERR_GOOGLE_CANCELLED': return 'Google izni verilmedi.';
    case 'ERR_GOOGLE_NETWORK': return "Google'a ulaşılamadı. İnternet açık mı?";
    case 'ERR_GOOGLE_CLIENT': return 'Bu sürüm için Google istemcisi henüz kurulmamış. Görevleri paylaşım ekranıyla ekleyebilirsin.';
    default: return "Google'a bağlanılamadı.";
  }
}
