import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  DiagnosticsSettings,
  ExperimentalSettings,
  GeneralSettings,
  UpdatesSettings
} from "@pwrgit/shared";

/** App-level (not per-profile) settings. Grows as later units need it.
 *  Experimental/diagnostics are stored sparsely — only keys the user changed;
 *  reads are defaulted at the settings:read handler. */
export type AppSettings = {
  /** Root under which PwrGit-managed worktrees are created (U14). */
  worktreeRoot?: string;
  /** The macOS Safe Storage prompt has been explained before it can appear. */
  macKeychainAccessExplained?: boolean;
  general?: Partial<GeneralSettings>;
  experimental?: Partial<ExperimentalSettings>;
  diagnostics?: Partial<DiagnosticsSettings>;
  /** Both keys are written together once the user picks a train or track. */
  updates?: Partial<UpdatesSettings>;
};

const DEFAULTS: AppSettings = {};

/**
 * Atomic JSON settings: write to a temp file then rename, so a crash never
 * leaves a half-written settings file. Path is injected (Electron-free) so it
 * is unit-testable against a temp directory.
 */
export class SettingsService {
  private cache: AppSettings;
  private readonly writeListeners = new Set<() => void>();

  constructor(private readonly filePath: string) {
    this.cache = this.readFromDisk();
  }

  get(): AppSettings {
    return { ...this.cache };
  }

  /** Fired after a successful disk write. Used by the updater to hide a
   *  downloaded file that no longer matches the selected train. */
  onWrite(listener: () => void): () => void {
    this.writeListeners.add(listener);
    return () => {
      this.writeListeners.delete(listener);
    };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.cache = { ...this.cache, ...patch };
    this.writeAtomic(this.cache);
    for (const listener of this.writeListeners) listener();
    return this.get();
  }

  private readFromDisk(): AppSettings {
    try {
      const parsed = JSON.parse(
        readFileSync(this.filePath, "utf8")
      ) as AppSettings;
      return { ...DEFAULTS, ...parsed };
    } catch {
      return { ...DEFAULTS };
    }
  }

  private writeAtomic(data: AppSettings): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }
}
