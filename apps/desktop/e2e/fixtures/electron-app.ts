import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron as electron,
  type ElectronApplication,
  type Page
} from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "..", "..", "out", "main", "index.js");

export type AppHandle = {
  app: ElectronApplication;
  window: Page;
  /** Set what the next native folder-picker (dialog:pickDirectory) returns. */
  setPickDirectory: (dir: string) => Promise<void>;
  cleanup: () => Promise<void>;
};

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

/**
 * Launch the built Electron app against an isolated, disposable userData dir
 * (fresh db / settings / profiles per run) and stub the native directory
 * picker so "Add repo folder…" can be driven from the UI. Requires
 * `out/main/index.js` — the pretest:e2e step (electron-vite build) produces it,
 * and better-sqlite3 must be built for Electron's ABI (the default after
 * `pnpm i`).
 */
export async function launchApp(
  opts: { worktreeRoot?: string } = {}
): Promise<AppHandle> {
  const userData = mkdtempSync(join(tmpdir(), "pwrgit-e2e-ud-"));
  if (opts.worktreeRoot !== undefined) {
    writeFileSync(
      join(userData, "settings.json"),
      JSON.stringify({ worktreeRoot: opts.worktreeRoot })
    );
  }

  const app = await electron.launch({
    args: [MAIN],
    env: cleanEnv({ PWRGIT_USER_DATA_DIR: userData })
  });
  const window = await app.firstWindow();
  await window.waitForSelector("#root");

  // Stub dialog.showOpenDialog in the main process; __pickDir drives the result.
  await app.evaluate(({ dialog }) => {
    const d = dialog as unknown as {
      __pickDir: string | null;
      showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;
    };
    d.__pickDir = null;
    d.showOpenDialog = async () => ({
      canceled: d.__pickDir === null,
      filePaths: d.__pickDir === null ? [] : [d.__pickDir]
    });
  });

  const setPickDirectory = async (dir: string): Promise<void> => {
    await app.evaluate(({ dialog }, d) => {
      (dialog as unknown as { __pickDir: string | null }).__pickDir = d;
    }, dir);
  };

  const cleanup = async (): Promise<void> => {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  };

  return { app, window, setPickDirectory, cleanup };
}
