import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const APP_UPDATE_FIRST_CHECK_DELAY_MS = 10 * 60 * 1_000;
export const APP_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

export type GitHubRelease = {
  assets?: Array<{ name?: string; state?: string }>;
  draft?: boolean;
  html_url?: string;
  name?: string;
  prerelease?: boolean;
  published_at?: string;
  tag_name?: string;
};

export type ReleaseCacheEntry = {
  releases: GitHubRelease[];
  etag?: string;
  fetchedAt: number;
};

export type UpdateReleaseState = {
  version: 1;
  firstSeenAt: number;
  lastCheckAt?: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  rateLimitResetAt?: number | undefined;
  retryNotBefore?: number | undefined;
  failures: number;
  cache?: ReleaseCacheEntry;
};

// Keep just the fields used by the updater, not release bodies or API metadata.
export function parseGitHubReleases(payload: unknown): GitHubRelease[] {
  if (!Array.isArray(payload)) return [];
  return payload.slice(0, 30).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.tag_name !== "string") return [];
    const release: GitHubRelease = { tag_name: value.tag_name };
    for (const key of ["html_url", "name", "published_at"] as const) {
      if (typeof value[key] === "string") release[key] = value[key];
    }
    for (const key of ["draft", "prerelease"] as const) {
      if (typeof value[key] === "boolean") release[key] = value[key];
    }
    if (Array.isArray(value.assets)) {
      release.assets = value.assets.flatMap((asset: unknown) => {
        if (!asset || typeof asset !== "object" || !("name" in asset) ||
            typeof asset.name !== "string") return [];
        return [{ name: asset.name, ...("state" in asset && typeof asset.state === "string"
          ? { state: asset.state } : {}) }];
      });
    }
    return [release];
  });
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseState(raw: string): UpdateReleaseState | undefined {
  const value = JSON.parse(raw) as Partial<UpdateReleaseState> | null;
  if (!value || value.version !== 1 || !timestamp(value.firstSeenAt) ||
      !Number.isInteger(value.failures) || value.failures! < 0 || value.failures! > 10) return;
  for (const key of ["lastCheckAt", "lastAttemptAt", "lastSuccessAt", "rateLimitResetAt", "retryNotBefore"] as const) {
    if (value[key] !== undefined && !timestamp(value[key])) return;
  }
  if (value.cache !== undefined) {
    if (!value.cache || !timestamp(value.cache.fetchedAt) || !Array.isArray(value.cache.releases) ||
        (value.cache.etag !== undefined && typeof value.cache.etag !== "string")) return;
    value.cache.releases = parseGitHubReleases(value.cache.releases);
  }
  return value as UpdateReleaseState;
}

/** One owner per userData directory (Electron's single-instance lock). Neither
 * profile, installed version nor selected channel creates a separate budget. */
export class UpdateReleaseStateStore {
  readonly state: UpdateReleaseState;

  constructor(private readonly filePath: string) {
    let loaded: UpdateReleaseState | undefined;
    try { loaded = parseState(readFileSync(filePath, "utf8")); } catch { /* fresh or corrupt state */ }
    this.state = loaded ?? { version: 1, firstSeenAt: Date.now(), failures: 0 };
    if (!loaded) this.save();
  }

  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  automaticCheckAt(): number {
    return Math.max(
      this.state.lastCheckAt === undefined
        ? this.state.firstSeenAt + APP_UPDATE_FIRST_CHECK_DELAY_MS
        : this.state.lastCheckAt + APP_UPDATE_CHECK_INTERVAL_MS,
      this.state.rateLimitResetAt ?? 0,
      this.state.retryNotBefore ?? 0
    );
  }

  automaticFetchAt(): number {
    return this.state.lastAttemptAt === undefined
      ? this.state.firstSeenAt + APP_UPDATE_FIRST_CHECK_DELAY_MS
      : this.state.lastAttemptAt + APP_UPDATE_CHECK_INTERVAL_MS;
  }
}
