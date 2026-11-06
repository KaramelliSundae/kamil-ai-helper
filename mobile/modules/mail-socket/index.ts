/** The native side of phone mail: see MailSocketModule.kt. Strings here hold one byte per character. */
import { requireNativeModule } from 'expo';

type MailSocketModule = {
  open(host: string, port: number, timeoutMs: number): Promise<number>;
  write(handle: number, data: string): Promise<void>;
  read(handle: number): Promise<string>;
  close(handle: number): Promise<void>;
};

const TIMEOUT_MS = 30000;

export async function openMailSocket(host: string, port: number) {
  // Looked up here rather than on import: without the native side only mail fails, not the whole app.
  const native = requireNativeModule<MailSocketModule>('MailSocket');
  const handle = await native.open(host, port, TIMEOUT_MS);
  return {
    write: (data: string) => native.write(handle, data),
    read: () => native.read(handle),
    close: () => native.close(handle),
  };
}
