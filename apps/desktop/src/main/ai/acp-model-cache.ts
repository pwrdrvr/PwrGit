// Persisted cache of the model lists ACP agents advertise. Ported from
// PwrSnap's `acp-model-cache.ts`.
//
// Listing models spawns the agent in ACP mode and opens a session — seconds —
// so without a durable cache every Settings open after a restart would pay
// that. The last list per agent is kept so the AI pages show it at once, and a
// refresh re-spawns to update it.
//
// Discovered metadata, not a choice anybody made, so it lives in its own file
// under userData rather than in the per-profile settings. The path is injected
// (Electron-free) so tests drive it against a temp directory. Atomic write
// (tmp → rename): a crash mid-write cannot corrupt it, and a corrupt or missing
// file is just an empty cache.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AcpAgentModelOption } from "@pwrgit/shared";
import { logMain } from "../logs";

const CACHE_VERSION = 1;

export type AcpModelCacheEntry = {
  models: AcpAgentModelOption[];
  /** The install the list was read from. A different active install may
   *  advertise different models, so a caller treats a mismatch as a miss. */
  command: string;
  discoveredAt: string;
};

type CacheFile = {
  version: number;
  agents: Record<string, AcpModelCacheEntry>;
};

/** Entries whose shape a caller can rely on. "Corrupt is empty" has to hold
 *  entry by entry, not just for the file: a half-written or hand-edited row
 *  reaches `entry.models.find(…)` in the service, where a missing array is a
 *  TypeError rather than a cache miss. */
function usableEntries(
  agents: Record<string, AcpModelCacheEntry>
): Record<string, AcpModelCacheEntry> {
  const usable: Record<string, AcpModelCacheEntry> = {};
  for (const [agentId, entry] of Object.entries(agents)) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      Array.isArray(entry.models) &&
      typeof entry.command === "string"
    ) {
      usable[agentId] = entry;
    }
  }
  return usable;
}

export class AcpModelCache {
  /** Parsed file. This process is the only writer, and `save` refreshes it,
   *  so a memo hit is always current. */
  private memo: CacheFile | null = null;

  constructor(private readonly filePath: string) {}

  /** The persisted entry for an agent, or undefined when never listed. */
  load(agentId: string): AcpModelCacheEntry | undefined {
    return this.read().agents[agentId];
  }

  /** Friendly label for a model id, across every cached agent. Model ids are
   *  effectively unique across agents, so a recorded id resolves without
   *  knowing which agent produced it. */
  findLabel(modelId: string): string | undefined {
    if (modelId.length === 0) return undefined;
    for (const entry of Object.values(this.read().agents)) {
      const match = entry.models.find((model) => model.id === modelId);
      if (match !== undefined && match.label.length > 0) return match.label;
    }
    return undefined;
  }

  /** Replace one agent's list. Best-effort: a failed write is logged, not
   *  thrown — the caller still has the list it just read. */
  save(agentId: string, entry: AcpModelCacheEntry): void {
    try {
      // A fresh object, never the memo mutated, so a failed write cannot leave
      // the memo ahead of the disk.
      const next: CacheFile = {
        version: CACHE_VERSION,
        agents: { ...this.read().agents, [agentId]: entry }
      };
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next), "utf8");
      renameSync(tmp, this.filePath);
      this.memo = next;
    } catch (cause) {
      logMain("warn", "ai", "failed to persist ACP model cache", {
        agentId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  private read(): CacheFile {
    if (this.memo !== null) return this.memo;
    let file: CacheFile = { version: CACHE_VERSION, agents: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<CacheFile>;
      if (
        parsed.version === CACHE_VERSION &&
        typeof parsed.agents === "object" &&
        parsed.agents !== null
      ) {
        file = { version: CACHE_VERSION, agents: usableEntries(parsed.agents) };
      }
    } catch {
      // Missing, unreadable, or corrupt → empty; re-listed on demand. Memoized
      // too, so a missing file is not re-read on every call.
    }
    this.memo = file;
    return file;
  }
}
