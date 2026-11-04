import { File, Paths } from 'expo-file-system';

import { Connection, serverUrl } from './api';

/**
 * Downloads one mail image into the app's cache. The server names each image by the SHA-256 of the JPEG
 * its sandbox produced, so a file that does not hash to its own name is refused and deleted.
 */
export async function loadMailImage(connection: Connection, id: string): Promise<string> {
  if (connection.mode !== 'server') throw new Error('Görseller yalnızca sunucudan gelir.');
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Geçersiz görsel.');
  const target = new File(Paths.cache, `mail-${id}.jpg`);
  if (target.exists && (await target.digest('SHA-256')) === id) return target.uri;
  if (target.exists) target.delete();
  let file: File;
  try {
    file = await File.downloadFileAsync(`${serverUrl(connection)}/v1/images/${id}`, target, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
  } catch {
    throw new Error('Görsel indirilemedi.');
  }
  if ((await file.digest('SHA-256')) !== id) {
    file.delete();
    throw new Error('Görsel bozuk geldi.');
  }
  return file.uri;
}
