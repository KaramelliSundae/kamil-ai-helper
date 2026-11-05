/**
 * Self-update. A server that publishes its own APK (mobile/publish.sh) comes first; otherwise the update comes from this
 * project's GitHub Releases, which is the only place a phone with no server can look. Either way the app compares
 * versionCodes, downloads, checks the SHA-256 and hands the file to Android's installer. Android then refuses any APK not
 * signed with the key of the installed app, and always asks the user to confirm, so one tap stays.
 */
import * as Application from 'expo-application';
import { File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';

import { api, ApiError, Connection, Release, serverUrl } from './api';

// A fork changes this to its own repository. Releases hold two files: latest.json and kamil.apk.
const RELEASES = 'https://github.com/KaramelliSundae/kamil-ai-helper/releases/latest/download';
const APK_TYPE = 'application/vnd.android.package-archive';
const FLAG_GRANT_READ_URI_PERMISSION = 1;

export function installedVersion(): { code: number; name: string } {
  return { code: Number(Application.nativeBuildVersion ?? 0), name: Application.nativeApplicationVersion ?? '?' };
}

async function latestOnGitHub(): Promise<Release | null> {
  let response: Response;
  try {
    response = await fetch(`${RELEASES}/latest.json`);
  } catch {
    throw new Error("GitHub'a ulaşılamadı. İnternet bağlantını kontrol et.");
  }
  if (response.status === 404) return null; // nothing published in this form yet
  if (!response.ok) throw new Error(`GitHub hata verdi (${response.status}).`);
  const latest = (await response.json()) as Release;
  if (!Number.isInteger(latest.versionCode) || !/^[0-9a-f]{64}$/.test(latest.sha256 ?? '')) {
    throw new Error("GitHub'daki sürüm bilgisi okunamadı.");
  }
  return { ...latest, source: 'github' };
}

/** The server's own release if it publishes one, otherwise GitHub's. A missing server release is not an error. */
async function latestRelease(connection: Connection | null): Promise<Release | null> {
  if (connection?.mode === 'server') {
    try {
      return { ...(await api.latestApp(connection)), source: 'server' };
    } catch (reason) {
      if (!(reason instanceof ApiError && reason.status === 404)) throw reason;
    }
  }
  return latestOnGitHub();
}

/** The published release when it is newer than this app, otherwise null. */
export async function findUpdate(connection: Connection | null): Promise<Release | null> {
  const latest = await latestRelease(connection);
  return latest && latest.versionCode > installedVersion().code ? latest : null;
}

export async function installUpdate(connection: Connection | null, release: Release): Promise<void> {
  const target = new File(Paths.cache, 'ai-ders-update.apk');
  if (target.exists) target.delete();
  let apk: File;
  try {
    apk = release.source === 'server' && connection?.mode === 'server'
      ? await File.downloadFileAsync(`${serverUrl(connection)}/v1/app/apk`, target, {
        headers: { Authorization: `Bearer ${connection.token}` },
      })
      : await File.downloadFileAsync(`${RELEASES}/kamil.apk`, target);
  } catch {
    throw new Error(release.source === 'server'
      ? 'Güncelleme indirilemedi. Telefonda Tailscale açık mı?'
      : 'Güncelleme indirilemedi. İnternet bağlantını kontrol et.');
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
