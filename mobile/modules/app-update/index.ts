/** The native side of the app's own update: see UpdateDownloadService.kt. */
import { NativeModule, requireNativeModule } from 'expo';

type Progress = { done: number; total: number };

declare class AppUpdateModule extends NativeModule<{ onProgress(progress: Progress): void }> {
  download(url: string, headers: Record<string, string>, target: string, title: string): Promise<void>;
  cancel(): void;
}

/** Looked up when used rather than on import: without the native side only this fails, not the whole app. */
const native = () => requireNativeModule<AppUpdateModule>('AppUpdate');

export async function downloadWithNotification(
  url: string,
  headers: Record<string, string>,
  target: string,
  title: string,
  onProgress: (progress: Progress) => void,
): Promise<void> {
  const module = native();
  const subscription = module.addListener('onProgress', onProgress);
  try {
    await module.download(url, headers, target, title);
  } finally {
    subscription.remove();
  }
}

export function cancelDownload(): void {
  native().cancel();
}

export function wasCancelled(reason: unknown): boolean {
  return (reason as { code?: string } | null)?.code === 'ERR_CANCELLED';
}
