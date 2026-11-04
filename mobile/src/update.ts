/**
 * Self-update from the home server. The server keeps the newest APK (mobile/publish.sh); the app compares
 * versionCodes, downloads over Tailscale, checks the SHA-256 and hands the file to Android's installer.
 * Android always asks the user to confirm an install from outside the Play Store, so one tap stays.
 */
import * as Application from 'expo-application';
import { File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';

import { api, ApiError, Connection, Release, serverUrl } from './api';

const APK_TYPE = 'application/vnd.android.package-archive';
const FLAG_GRANT_READ_URI_PERMISSION = 1;

export function installedVersion(): { code: number; name: string } {
  return { code: Number(Application.nativeBuildVersion ?? 0), name: Application.nativeApplicationVersion ?? '?' };
}

/** The published release when it is newer than this app, otherwise null. */
export async function findUpdate(connection: Connection): Promise<Release | null> {
  if (connection.mode !== 'server') return null; // the phone mode has no server to update from
  try {
    const latest = await api.latestApp(connection);
    return latest.versionCode > installedVersion().code ? latest : null;
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404) return null; // nothing published yet
    throw reason;
  }
}

export async function installUpdate(connection: Connection, release: Release): Promise<void> {
  if (connection.mode !== 'server') throw new Error('Güncelleme yalnızca sunucudan gelir.');
  const target = new File(Paths.cache, 'ai-ders-update.apk');
  if (target.exists) target.delete();
  let apk: File;
  try {
    apk = await File.downloadFileAsync(`${serverUrl(connection)}/v1/app/apk`, target, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
  } catch {
    throw new Error('Güncelleme indirilemedi. Telefonda Tailscale açık mı?');
  }
  if ((await apk.digest('SHA-256')) !== release.sha256) {
    apk.delete();
    throw new Error('İndirilen dosya bozuk çıktı, tekrar dene.');
  }
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: apk.contentUri,
    type: APK_TYPE,
    flags: FLAG_GRANT_READ_URI_PERMISSION,
  });
}
