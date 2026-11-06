/**
 * Self-update. A server that publishes its own APK (mobile/publish.sh) comes first; otherwise the update comes from this
 * project's GitHub Releases, which is the only place a phone with no server can look. Either way the app compares
 * versionCodes, downloads, checks the SHA-256 and hands the file to Android's installer. Android then refuses any APK not
 * signed with the key of the installed app, and always asks the user to confirm, so one tap stays.
 */
import * as Application from 'expo-application';
import { File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

import { cancelDownload, downloadWithNotification, wasCancelled } from '../modules/app-update';
import { api, Connection, Release, serverUrl } from './api';
import { ChangeNote, changelog, GitHubRelease } from './changelog';
import { CHANNEL_DEFAULT } from './phone/watcher';

// A fork changes this to its own repository. Releases hold two files, latest.json and kamil.apk, and their notes are the changelog.
const REPOSITORY = 'KaramelliSundae/kamil-ai-helper';
const RELEASES = `https://github.com/${REPOSITORY}/releases/latest/download`;
const APK_TYPE = 'application/vnd.android.package-archive';
const FLAG_GRANT_READ_URI_PERMISSION = 1;
const READY_NOTICE = 'update-ready';

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

/**
 * The published release when it is newer than this app, otherwise null. A server's own release goes first if it is newer,
 * but an old one, or a server out of reach, must not hide what GitHub has.
 */
export async function findUpdate(connection: Connection | null): Promise<Release | null> {
  const installed = installedVersion().code;
  if (connection?.mode === 'server') {
    try {
      const own = await api.latestApp(connection);
      if (own.versionCode > installed) return { ...own, source: 'server' };
    } catch {
      // Nothing published there, or the server is out of reach: GitHub can still answer.
    }
  }
  const latest = await latestOnGitHub();
  return latest && latest.versionCode > installed ? latest : null;
}

/** See changelog.ts. Only the update's description depends on this, so a failure here stops nothing else. */
export async function loadChangelog(newerOnly: boolean): Promise<ChangeNote[]> {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub hata verdi (${response.status}).`);
  return changelog((await response.json()) as GitHubRelease[], installedVersion().name, newerOnly);
}

export type UpdateStage =
  | { kind: 'idle' }
  | { kind: 'downloading'; fraction: number | null; cancellable: boolean }
  | { kind: 'checking' }
  | { kind: 'installing' };

// Kept out here because the panel on Bugün and the one in Ayarlar show the same download, and it outlives both.
let stage: UpdateStage = { kind: 'idle' };
let running: Promise<void> | null = null;
const watchers = new Set<() => void>();

function setStage(next: UpdateStage): void {
  stage = next;
  watchers.forEach((watcher) => watcher());
}

export const updateStage = {
  subscribe(watcher: () => void): () => void {
    watchers.add(watcher);
    return () => watchers.delete(watcher);
  },
  get: () => stage,
};

export function cancelUpdate(): void {
  cancelDownload();
}

async function askToNotify(): Promise<void> {
  try {
    if (!(await Notifications.getPermissionsAsync()).granted) await Notifications.requestPermissionsAsync();
  } catch {
    // The panel shows the progress too.
  }
}

async function download(connection: Connection | null, release: Release, target: File): Promise<void> {
  const fromServer = release.source === 'server' && connection?.mode === 'server';
  const url = fromServer ? `${serverUrl(connection)}/v1/app/apk` : `${RELEASES}/kamil.apk`;
  const headers: Record<string, string> = fromServer ? { Authorization: `Bearer ${connection.token}` } : {};
  setStage({ kind: 'downloading', fraction: null, cancellable: true });
  try {
    await downloadWithNotification(url, headers, target.uri, `Kamil ${release.versionName} indiriliyor`, ({ done, total }) => {
      setStage({ kind: 'downloading', fraction: total > 0 ? done / total : null, cancellable: true });
    });
    return;
  } catch (reason) {
    if (wasCancelled(reason)) throw reason;
  }
  // The notification is a nicety. Whatever went wrong with it, the update must still get through.
  setStage({ kind: 'downloading', fraction: null, cancellable: false });
  if (target.exists) target.delete();
  try {
    await File.downloadFileAsync(url, target, { headers });
  } catch {
    throw new Error(fromServer ? 'Güncelleme indirilemedi. Telefonda Tailscale açık mı?' : 'Güncelleme indirilemedi. İnternet bağlantını kontrol et.');
  }
}

/** Android will not open the installer over another app, so a download that ends in the background waits for the student. */
async function untilOnScreen(release: Release): Promise<void> {
  if (AppState.currentState === 'active') return;
  await Notifications.scheduleNotificationAsync({
    identifier: READY_NOTICE,
    content: { title: `Kamil ${release.versionName} hazır`, body: 'Kurmak için dokun.' },
    trigger: { channelId: CHANNEL_DEFAULT },
  }).catch(() => undefined);
  await new Promise<void>((resolve) => {
    const watcher = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      watcher.remove();
      resolve();
    });
  });
  await Notifications.dismissNotificationAsync(READY_NOTICE).catch(() => undefined);
}

async function downloadAndInstall(connection: Connection | null, release: Release): Promise<void> {
  const target = new File(Paths.cache, 'ai-ders-update.apk');
  setStage({ kind: 'checking' });
  // A download whose installer was closed, or that finished after the app was gone, needs no second download.
  const ready = target.exists && (await target.digest('SHA-256')) === release.sha256;
  if (!ready) {
    if (target.exists) target.delete();
    await askToNotify();
    await download(connection, release, target);
    setStage({ kind: 'checking' });
    if ((await target.digest('SHA-256')) !== release.sha256) {
      target.delete();
      throw new Error('İndirilen dosya bozuk çıktı, tekrar dene.');
    }
  }
  setStage({ kind: 'installing' });
  await untilOnScreen(release);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: target.contentUri,
    type: APK_TYPE,
    flags: FLAG_GRANT_READ_URI_PERMISSION,
  });
}

/** Resolves when the installer is closed or the student cancelled the download. Asking twice joins the first. */
export function installUpdate(connection: Connection | null, release: Release): Promise<void> {
  running ??= downloadAndInstall(connection, release)
    .catch((reason: unknown) => {
      if (!wasCancelled(reason)) throw reason;
    })
    .finally(() => {
      running = null;
      setStage({ kind: 'idle' });
    });
  return running;
}
