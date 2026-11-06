/** What each release changed, from the notes on its GitHub release. Shown as plain text: no links, nothing to load. */
export type ChangeNote = { version: string; date: string | null; lines: string[] };

export type GitHubRelease = {
  tag_name?: string;
  body?: string | null;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
};

const MOST_RELEASES = 10;
const MOST_LINES = 20;

function versionParts(version: string): number[] {
  return version.replace(/^v/, '').split('.').map((part) => Number(part) || 0);
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function noteLines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s+/, '').replace(/\*\*/g, ''))
    .filter(Boolean)
    .slice(0, MOST_LINES);
}

/** Newest first. `newerOnly` gives what an update would bring; otherwise what this version and those before it brought. */
export function changelog(releases: GitHubRelease[], installed: string, newerOnly: boolean): ChangeNote[] {
  return releases
    .filter((release) => release.tag_name && !release.draft && !release.prerelease)
    .filter((release) => {
      const order = compareVersions(release.tag_name!, installed);
      return newerOnly ? order > 0 : order <= 0;
    })
    .sort((a, b) => compareVersions(b.tag_name!, a.tag_name!))
    .slice(0, MOST_RELEASES)
    .map((release) => ({
      version: release.tag_name!.replace(/^v/, ''),
      date: release.published_at ?? null,
      lines: noteLines(release.body ?? ''),
    }));
}
