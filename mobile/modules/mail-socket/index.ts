/** The native side of phone mail: see MailSocketModule.kt. Strings here hold one byte per character. */
import { requireNativeModule } from 'expo';

type MailSocketModule = {
  open(host: string, port: number, timeoutMs: number): Promise<number>;
  openStartTls(host: string, port: number, timeoutMs: number): Promise<number>;
  write(handle: number, data: string): Promise<void>;
  read(handle: number): Promise<string>;
  close(handle: number): Promise<void>;
};

const TIMEOUT_MS = 30000;

// Looked up when used rather than on import: without the native side only mail fails, not the whole app.
const native = () => requireNativeModule<MailSocketModule>('MailSocket');

function connection(handle: number) {
  const socket = native();
  return {
    write: (data: string) => socket.write(handle, data),
    read: () => socket.read(handle),
    close: () => socket.close(handle),
  };
}

export async function openMailSocket(host: string, port: number) {
  return connection(await native().open(host, port, TIMEOUT_MS));
}

/** For sending on port 587. The server's greeting is already behind, on the encrypted side nothing has been said yet. */
export async function openStartTlsSocket(host: string, port: number) {
  return connection(await native().openStartTls(host, port, TIMEOUT_MS));
}
