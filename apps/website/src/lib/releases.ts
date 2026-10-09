export interface Release {
  packageName: string;
  version: string;
  body: string;
  url: string;
  publishedAt: string;
}

// Fail the build instead of replacing the deployed changelog with incomplete notes.
export async function fetchReleases(token?: string, request: typeof fetch = fetch): Promise<Release[]> {
  const releases: Release[] = [];
  for (let page = 1; ; page++) {
    const response = await request(
      `https://api.github.com/repos/opfs-vfs/opfs-vfs/releases?per_page=100&page=${page}`,
      {
        headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`GitHub releases request failed: ${response.status}`);
    const entries: unknown = await response.json();
    if (!Array.isArray(entries)) throw new Error('Invalid GitHub releases response');
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.tag_name !== 'string')
        throw new Error('Invalid GitHub release');
      if (entry.draft || entry.prerelease) continue;
      const match = /^(@opfs-vfs\/[^@]+)@(\d+\.\d+\.\d+)$/.exec(entry.tag_name);
      if (!match) continue;
      if (
        typeof entry.body !== 'string' ||
        typeof entry.published_at !== 'string' ||
        !Number.isFinite(Date.parse(entry.published_at))
      ) {
        throw new Error(`Missing release notes or date: ${entry.tag_name}`);
      }
      releases.push({
        packageName: match[1]!,
        version: match[2]!,
        body: entry.body,
        url: `https://github.com/opfs-vfs/opfs-vfs/releases/tag/${encodeURIComponent(entry.tag_name)}`,
        publishedAt: entry.published_at,
      });
    }
    if (entries.length < 100) break;
  }
  return releases.sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }));
}
