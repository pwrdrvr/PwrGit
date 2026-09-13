import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron as electron,
  type ElectronApplication,
  type Page
} from "@playwright/test";
import type { Profile, ProfileList, PwrGitError, Result } from "@pwrgit/shared";

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

type RecoverableBootRead = "profile:list" | "repo:list" | "forge:status";

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
 * The active profile as main sees it. `window.pwrgit` is declared for the
 * renderer's own build, not for specs, so the bridge is typed here once
 * instead of casting at every call site.
 */
export async function readActiveProfile(window: Page): Promise<Profile> {
  const res = (await window.evaluate(() =>
    (
      window as unknown as {
        pwrgit: { dispatch: (cmd: string, arg: undefined) => Promise<unknown> };
      }
    ).pwrgit.dispatch("profile:list", undefined)
  )) as Result<ProfileList, PwrGitError>;
  if (!res.ok) throw new Error(`profile:list failed: ${res.error.message}`);
  const active = res.value.profiles.find(
    (p) => p.id === res.value.activeProfileId
  );
  if (active === undefined) throw new Error("no active profile");
  return active;
}

/**
 * Fail loudly, and immediately, when the first-run wizard would cover the app.
 *
 * The wizard's overlay is `position: fixed; inset: 0; z-index: 200`, so its
 * scrim swallows every click a spec makes. Nothing about the resulting failure
 * mentions onboarding: a spec either reports "element(s) not found" for a row
 * that is genuinely in the DOM behind the scrim, or retries a click until the
 * test times out. Two shards once burned the full 20-minute job limit that way
 * and the annotation said only "exceeded the maximum execution time".
 *
 * Checked through `profile:list` rather than by looking for the overlay: the
 * flag is main's own answer, read straight out of SQLite, so there is no race
 * against the renderer mounting. A DOM check would have to guess how long to
 * wait for an overlay that is supposed never to appear.
 */
async function assertNoOnboardingWizard(window: Page): Promise<void> {
  const active = await readActiveProfile(window);
  if (!active.onboardingCompleted) {
    throw new Error(
      [
        "PwrGit E2E launch would open the first-run onboarding wizard.",
        `  Profile "${active.name}" read back onboardingCompleted = false.`,
        "  Every click this spec makes would land on the wizard's scrim.",
        "  PWRGIT_E2E_ONBOARDING_DONE=1 should have seeded it in main's",
        "  ensureSeed() — check that seam, or pass seedOnboarding: false if",
        "  this spec means to drive the wizard."
      ].join("\n")
    );
  }
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
  opts: {
    agentAccess?: boolean;
    worktreeRoot?: string;
    gitConfig?: string;
    forgeFixturePath?: string;
    theme?: "system" | "dark" | "light";
    /** Override the seeded profile identity. Must REPLACE the default block
     *  rather than append after it: `readGitIdentityDefaults` regexes the
     *  first `name`/`email` in the file, so a second [user] section is
     *  silently ignored (git's own last-wins semantics do not apply). */
    identity?: { name: string; email: string };
    /**
     * Seed the profile as already onboarded. Defaults to `true`: every launch
     * gets a fresh userData dir, so without it the first-run wizard opens over
     * the window and its scrim eats every click the spec makes. Wizard specs
     * pass `false` to get the genuine first run.
     */
    seedOnboarding?: boolean;
    failReadOnce?: RecoverableBootRead[];
    /** Milliseconds per step of the dev/QA fake update (see
     *  `simulateDevUpdateCheck`). Slow it down to act on a card that only
     *  exists mid-download. */
    updateStepMs?: number;
  } = {}
): Promise<AppHandle> {
  const userData = mkdtempSync(join(tmpdir(), "pwrgit-e2e-ud-"));
  if (opts.worktreeRoot !== undefined || opts.theme !== undefined) {
    const seededSettings = {
      ...(opts.worktreeRoot !== undefined
        ? { worktreeRoot: opts.worktreeRoot }
        : {}),
      ...(opts.theme !== undefined ? { general: { theme: opts.theme } } : {})
    };
    writeFileSync(
      join(userData, "settings.json"),
      JSON.stringify(seededSettings)
    );
  }
  // Pin the seeded profile identity to the sandbox's commit identity so
  // "mine" detection (authored-by-me) is deterministic — never the identity
  // of whatever machine happens to run the tests.
  const gitconfig = join(userData, "gitconfig");
  const identity = opts.identity ?? {
    name: "PwrGit Test",
    email: "test@pwrgit.com"
  };
  writeFileSync(
    gitconfig,
    `[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n${opts.gitConfig ?? ""}`
  );

  const seedOnboarding = opts.seedOnboarding ?? true;

  const app = await electron.launch({
    args: [MAIN],
    env: cleanEnv({
      ...(opts.agentAccess ? { PWRGIT_E2E_AGENT_ACCESS_PORT: "0" } : {}),
      PWRGIT_USER_DATA_DIR: userData,
      PWRGIT_GITCONFIG: gitconfig,
      ...(seedOnboarding ? { PWRGIT_E2E_ONBOARDING_DONE: "1" } : {}),
      // The app's Git commands must be as deterministic as fixture setup:
      // neither side may inherit the runner/developer's aliases, identity,
      // signing, merge drivers, or other machine-global behavior.
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...(opts.forgeFixturePath === undefined
        ? {}
        : { PWRGIT_E2E_FORGE_FIXTURE: opts.forgeFixturePath }),
      ...(opts.failReadOnce === undefined
        ? {}
        : { PWRGIT_E2E_FAIL_READ_ONCE: opts.failReadOnce.join(",") }),
      ...(opts.updateStepMs === undefined
        ? {}
        : { PWRGIT_E2E_UPDATE_STEP_MS: String(opts.updateStepMs) })
    })
  });
  const window = await app.firstWindow();
  await window.waitForSelector("#root");
  if (seedOnboarding) await assertNoOnboardingWizard(window);

  // Stub dialog.showOpenDialog in the main process; __pickDirs drives either a
  // single returned path or a multi-selection through the shared picker.
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
