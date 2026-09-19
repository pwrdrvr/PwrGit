// Persisted Codex model lists — the Codex twin of `acp-model-cache.ts`.
//
// Ported from PwrSnap's `codex-model-cache.ts`, which keeps an id → display
// name map so a run's recorded model id can be shown by name. PwrGit keeps the
// whole list instead: the AI pages need each model's advertised reasoning
// efforts as well as its name, and listing them means starting Codex's App
// Server. With the list on disk, AI Features renders its pickers at once and
// a refresh updates them.
//
// Keyed by binary + CODEX_HOME: which models a Codex offers depends on the
// build and on the account it is signed in to. Same atomic-write and
// corrupt-is-empty rules as the ACP cache.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CodexModelOption } from "@pwrgit/shared";
import { logMain } from "../logs";

const CACHE_VERSION = 1;
/** Lists kept. One per binary/account pair a profile has used; the oldest
 *  goes first, so switching accounts back and forth stays instant. */
const MAX_LISTS = 8;

export type CodexModelCacheEntry = {
  models: CodexModelOption[];
  discoveredAt: string;
};

type CacheFile = {
  version: number;
  lists: Record<string, CodexModelCacheEntry>;
};

/** The key one binary + account pair's list is stored under. JSON rather than
 *  a joined string, so no path can contain the separator. */
export function codexModelCacheKey(command: string, codexHome: string): string {
  return JSON.stringify([command, codexHome]);
}

export class CodexModelCache {
  private memo: CacheFile | null = null;

  constructor(private readonly filePath: string) {}

  load(key: string): CodexModelCacheEntry | undefined {
    return this.read().lists[key];
  }

  /** Display name for a model id from any cached list, or undefined when it
   *  is unknown or its name is the id. The caller falls back to the id. */
  findLabel(id: string): string | undefined {
    if (id.length === 0) return undefined;
    for (const entry of Object.values(this.read().lists)) {
      const match = entry.models.find((model) => model.id === id);
      if (match !== undefined && match.displayName.length > 0 && match.displayName !== id) {
        return match.displayName;
      }
    }
    return undefined;
  }

  save(key: string, entry: CodexModelCacheEntry): void {
    try {
      // Re-inserted rather than overwritten in place, so the key moves to the
      // end and eviction below drops the least recently listed pair.
      const lists = { ...this.read().lists };
      delete lists[key];
      lists[key] = entry;
      const keys = Object.keys(lists);
      for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_LISTS))) {
        delete lists[stale];
      }
      const next: CacheFile = { version: CACHE_VERSION, lists };
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next), "utf8");
      renameSync(tmp, this.filePath);
      this.memo = next;
    } catch (cause) {
      logMain("warn", "ai", "failed to persist Codex model cache", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  private read(): CacheFile {
    if (this.memo !== null) return this.memo;
    let file: CacheFile = { version: CACHE_VERSION, lists: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<CacheFile>;
      if (
        parsed.version === CACHE_VERSION &&
        typeof parsed.lists === "object" &&
        parsed.lists !== null
      ) {
        file = { version: CACHE_VERSION, lists: parsed.lists };
      }
    } catch {
      // Missing, unreadable, or corrupt → empty; re-listed on demand.
    }
    this.memo = file;
    return file;
  }
}
