import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { open, readFile, rename, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseGhStackCatalog, requireWritableCatalog, type ApplyHooks, type CatalogStore, type GhStackCatalog, type StackJournalEntry } from "./stack-engine";

import type { ConflictJournal } from "./stack-conflicts";

type ApplyJournal = StackJournalEntry & { resolution?: { journal: ConflictJournal; tip: string } };

const foreignJournals = {
  "gh-stack-rebase-state": "gh stack is mid-rebase in this clone",
  "gh-stack-modify-state": "gh stack is modifying a stack in this clone",
  "gh-stack-migration": "gh stack is migrating a stack in this clone",
  "pwragent-stack-op.json": "PwrAgent has a stack operation in this clone",
} as const;
const journal = "pwrgit-stack-op.json";
const exec = promisify(execFile);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export class NativeStackLocks {
  constructor(private readonly binary: () => string) {}

  async withLock<T>(commonDir: string, kind: "operation" | "catalog", fn: () => Promise<T>): Promise<T> {
    const held = await this.acquire(commonDir, kind, "wait");
    if (!held) throw new Error("gh stack is running in this clone");
    try {
      return await fn();
    } finally {
      await held();
    }
  }

  async busy(commonDir: string): Promise<boolean> {
    const release = await this.acquire(commonDir, "operation", "probe");
    if (!release) return true;
    try {
      const catalog = await this.acquire(commonDir, "catalog", "probe");
      if (!catalog) return true;
      await catalog();
      return false;
    } finally {
      await release();
    }
  }

  private async acquire(commonDir: string, kind: "operation" | "catalog", mode: "wait" | "probe") {
    const child = spawn(this.binary(), ["--desktop-stack-lock", commonDir, kind, mode], { windowsHide: true });
    child.stdin.on("error", () => undefined);
    let diagnostics = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { diagnostics += chunk; });
    const closed = once(child, "close").then(([code]) => Number(code));
    const acquired = new Promise<true>(resolve => {
      let line = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        line += chunk;
        if (line === "locked\n") resolve(true);
      });
    });
    try {
      const ready = await Promise.race([acquired, closed]);
      if (ready === 75) return null;
      if (ready !== true) throw new Error(diagnostics.trim() || "The native stack lock helper did not acquire the lock");
      return async () => {
        child.stdin.end();
        await closed;
      };
    } catch (error) {
      child.stdin.end();
      throw error;
    }
  }

  async replace(commonDir: string, temporary: string, destination: string): Promise<void> {
    if (process.platform === "win32") {
      await exec(this.binary(), ["--desktop-stack-replace", commonDir, temporary, destination], { windowsHide: true });
    } else {
      await rename(join(commonDir, temporary), join(commonDir, destination));
      await syncDirectory(commonDir);
    }
  }
}

async function syncDirectory(commonDir: string) {
  if (process.platform === "win32") return;
  const dir = await open(commonDir, "r");
  try { await dir.sync(); } finally { await dir.close(); }
}

export class GhStackCatalogStore implements CatalogStore {
  constructor(private readonly locks: NativeStackLocks, private readonly filename: "gh-stack" | "pwrgit-stack" = "gh-stack") {}

  async read(commonDir: string) {
    try {
      const bytes = await readFile(join(commonDir, this.filename));
      return { catalog: parseGhStackCatalog(bytes.toString("utf8")), sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) {
      if (!missing(error)) throw error;
      const catalog: GhStackCatalog = { schemaVersion: 1, repository: "", stacks: [] };
      return { catalog, sha256: "" };
    }
  }

  async journalBlocker(commonDir: string, allowOwn = false): Promise<string | undefined> {
    for (const [file, message] of Object.entries(foreignJournals)) {
      if (await exists(join(commonDir, file))) return message;
    }
    if (!allowOwn && await exists(join(commonDir, journal))) return "PwrGit has an unfinished stack operation in this clone";
    return undefined;
  }

  withOperationLock<T>(commonDir: string, fn: () => Promise<T>): Promise<T> {
    return this.withJournalLock(commonDir, false, fn);
  }

  withJournalLock<T>(commonDir: string, allowOwn: boolean, fn: () => Promise<T>): Promise<T> {
    return this.locks.withLock(commonDir, "operation", async () => {
      const blocker = await this.journalBlocker(commonDir, allowOwn);
      if (blocker) throw new Error(blocker);
      // A catalog-only holder must be noticed before any branch can move.
      // No catalog lock is retained across Git or worktree mutations.
      await this.locks.withLock(commonDir, "catalog", async () => undefined);
      return fn();
    });
  }

  async writeIfUnchanged(commonDir: string, next: GhStackCatalog, sha256: string): Promise<void> {
    await this.locks.withLock(commonDir, "catalog", async () => {
      const current = await this.read(commonDir);
      requireWritableCatalog(current.catalog);
      requireWritableCatalog(next);
      if (current.sha256 !== sha256) throw new Error("The stack catalog changed. Plan the operation again.");
      if (JSON.stringify(current.catalog) !== JSON.stringify(next)) {
        await this.atomicWrite(commonDir, this.filename, next);
      }
    });
  }

  async readJournal(commonDir: string): Promise<unknown> {
    try { return JSON.parse(await readFile(join(commonDir, journal), "utf8")); }
    catch (error) {
      if (!missing(error)) throw error;
      return undefined;
    }
  }

  async readResolutionJournal(commonDir: string): Promise<ConflictJournal | undefined> {
    const entry = await this.readJournal(commonDir) as ConflictJournal | undefined;
    return entry?.kind === "resolution" ? entry : undefined;
  }

  async readApplyJournal(commonDir: string): Promise<ApplyJournal | undefined> {
    const entry = await this.readJournal(commonDir) as Partial<ApplyJournal> | undefined;
    if ((entry?.direction === "apply" || entry?.direction === "undo") && entry.receipt && Array.isArray(entry.worktrees)) {
      return entry as ApplyJournal;
    }
    return undefined;
  }

  writeJournal(commonDir: string, value: unknown): Promise<void> {
    return this.atomicWrite(commonDir, journal, value);
  }

  async removeJournal(commonDir: string): Promise<void> {
    await unlink(join(commonDir, journal));
    await syncDirectory(commonDir);
  }

  journalHooks(commonDir: string, resolution?: ApplyJournal["resolution"]): ApplyHooks {
    return {
      begin: entry => this.writeJournal(commonDir, resolution ? { ...entry, resolution } : entry),
      finish: () => this.removeJournal(commonDir),
    };
  }

  private async atomicWrite(commonDir: string, destination: string, value: unknown) {
    const temporary = `.pwrgit-stack-${randomUUID()}.tmp`;
    const path = join(commonDir, temporary);
    const file = await open(path, "wx", 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(value, null, 2) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await this.locks.replace(commonDir, temporary, destination);
    } finally {
      await unlink(path).catch(error => { if (!missing(error)) throw error; });
    }
  }
}
