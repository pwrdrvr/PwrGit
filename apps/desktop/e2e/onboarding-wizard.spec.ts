import { expect, test } from "@playwright/test";
import {
  launchApp,
  readActiveProfile,
  type AppHandle
} from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { lensChip, repoGroup } from "./fixtures/steps";

/**
 * The first-run wizard, driven as a genuine first run.
 *
 * Every other spec launches with `seedOnboarding` at its default of `true`
 * precisely so this surface stays out of the way; this is the one that turns
 * it off. If these two pass and the rest of the suite starts timing out, the
 * seam in `ensureSeed` is what broke — see `fixtures/electron-app.ts`.
 */

/** Indexing two fixture repos, on a loaded CI runner. */
const SCAN_MS = 20_000;

let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  sandbox?.cleanup();
  sandbox = null;
});

const wizard = (h: AppHandle) => h.window.locator(".onboarding-wizard");
const title = (h: AppHandle) => h.window.locator(".onboarding-wizard__title");
const nextButton = (h: AppHandle) =>
  h.window.locator(".onboarding-wizard__btn--primary");
/** The field labels wrap their input, so name the field and reach in. */
const field = (h: AppHandle, label: string) =>
  h.window
    .locator(".onboarding-wizard__field", { hasText: label })
    .locator("input");

/** Read the flag back from main — the same answer the next launch will get. */
const onboardingCompleted = async (h: AppHandle): Promise<boolean> =>
  (await readActiveProfile(h.window)).onboardingCompleted;

test("walks a first run from welcome to a populated sidebar", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("atlas-forge");
  sandbox.makeRepo("ledger-api");

  handle = await launchApp({
    seedOnboarding: false,
    worktreeRoot: sandbox.worktreeRoot
  });
  const { window } = handle;

  await expect(wizard(handle)).toBeVisible();
  await expect(title(handle)).toHaveText(
    "Point PwrGit at your code, and it does the finding."
  );

  // Welcome → Identity.
  await nextButton(handle).click();

  // Identity is read through `git config`, so it reflects this launch's
  // GIT_CONFIG_GLOBAL rather than whatever the runner has set globally.
  await expect(field(handle, "Author name")).toHaveValue("PwrGit Test");
  await expect(field(handle, "Author e-mail")).toHaveValue("test@pwrgit.com");
  await nextButton(handle).click();

  // Forges → the scan explainer → the folder picker.
  await expect(title(handle)).toHaveText(
    "Where PwrGit reads pull and merge requests from."
  );
  await nextButton(handle).click();
  await expect(title(handle)).toHaveText(
    "You name folders. PwrGit does the finding."
  );
  await nextButton(handle).click();

  await expect(window.locator(".onboarding-wizard__roots-empty")).toBeVisible();
  await handle.setPickDirectories([sandbox.reposDir]);
  await window.getByRole("button", { name: "+ Add a folder…" }).click();
  await expect(window.locator(".onboarding-wizard__root-path")).toHaveText(
    sandbox.reposDir
  );

  // The button counts what was actually added, not what was offered.
  await expect(nextButton(handle)).toHaveText("Scan 1 folder →");
  await nextButton(handle).click();

  await expect(title(handle)).toHaveText("Found 2 repositories.", {
    timeout: SCAN_MS
  });
  await nextButton(handle).click();

  // Done counts only what a scan knows: repos, worktrees, folders. No lens
  // counts, no ahead/behind — none of that is read until a repo is opened.
  await expect(title(handle)).toHaveText(
    "2 repositories, 2 worktrees, 1 folder."
  );
  expect(await onboardingCompleted(handle)).toBe(false);

  await nextButton(handle).click();
  await expect(wizard(handle)).toBeHidden();

  // Assert under All, the way every other spec does. The default lens is
  // Focused, whose ladder depends on per-worktree git state the scan has not
  // read yet — which is the very thing the Done screen warns about, and not
  // what this spec is here to pin down.
  await lensChip(window, "All").click();
  await expect(repoGroup(window, "atlas-forge")).toBeVisible({
    timeout: SCAN_MS
  });
  await expect(repoGroup(window, "ledger-api")).toBeVisible();
  expect(await onboardingCompleted(handle)).toBe(true);
});

test("skipping counts as done, so the next launch is not ambushed", async () => {
  handle = await launchApp({ seedOnboarding: false });

  await expect(wizard(handle)).toBeVisible();
  expect(await onboardingCompleted(handle)).toBe(false);

  await handle.window.getByRole("button", { name: "Skip setup" }).click();

  await expect(wizard(handle)).toBeHidden();
  expect(await onboardingCompleted(handle)).toBe(true);
});
