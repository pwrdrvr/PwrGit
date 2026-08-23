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
  /** Set what the next folder picker returns (single or multi-select). */
  setPickDirectory: (dir: string) => Promise<void>;
  setPickDirectories: (dirs: string[]) => Promise<void>;
  cleanup: () => Promise<void>;
};

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // A PwrAgent/PwrSnap/PwrGit dev process can be the parent of this test run.
  // electron-vite's renderer URL belongs to that parent app; allowing it into
  // the built PwrGit process makes PwrGit main load the other app's renderer.
  delete env.ELECTRON_RENDERER_URL;
  return { ...env, NODE_ENV: "production", ...extra };
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
  opts: { worktreeRoot?: string; gitConfig?: string } = {}
): Promise<AppHandle> {
  const userData = mkdtempSync(join(tmpdir(), "pwrgit-e2e-ud-"));
  if (opts.worktreeRoot !== undefined) {
    writeFileSync(
      join(userData, "settings.json"),
      JSON.stringify({ worktreeRoot: opts.worktreeRoot })
    );
  }
  // Pin the seeded profile identity to the sandbox's commit identity so
  // "mine" detection (authored-by-me) is deterministic — never the identity
  // of whatever machine happens to run the tests.
  const gitconfig = join(userData, "gitconfig");
  writeFileSync(
    gitconfig,
    `[user]\n\tname = PwrGit Test\n\temail = test@pwrgit.dev\n${opts.gitConfig ?? ""}`
  );

  const app = await electron.launch({
    args: [MAIN],
    env: cleanEnv({
      PWRGIT_USER_DATA_DIR: userData,
      PWRGIT_GITCONFIG: gitconfig,
      // The app's Git commands must be as deterministic as fixture setup:
      // neither side may inherit the runner/developer's aliases, identity,
      // signing, merge drivers, or other machine-global behavior.
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_CONFIG_SYSTEM: "/dev/null"
    })
  });
  const window = await app.firstWindow();
  await window.waitForSelector("#root");

  // Stub dialog.showOpenDialog in the main process; __pickDirs drives the result
  // (works for both the single and multi-select handlers).
  await app.evaluate(({ dialog }) => {
    const d = dialog as unknown as {
      __pickDirs: string[];
      showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;
    };
    d.__pickDirs = [];
    d.showOpenDialog = async () => ({
      canceled: d.__pickDirs.length === 0,
      filePaths: d.__pickDirs
    });
  });

  const setPickDirectories = async (dirs: string[]): Promise<void> => {
    await app.evaluate(({ dialog }, ds) => {
      (dialog as unknown as { __pickDirs: string[] }).__pickDirs = ds;
    }, dirs);
  };
  const setPickDirectory = (dir: string): Promise<void> =>
    setPickDirectories([dir]);

  const cleanup = async (): Promise<void> => {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  };

  return { app, window, setPickDirectory, setPickDirectories, cleanup };
}
