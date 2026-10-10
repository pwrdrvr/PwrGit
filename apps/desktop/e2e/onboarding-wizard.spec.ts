import { expect, test } from "@playwright/test";
import { FORGE_KINDS, forgeInstall, forgeProduct } from "@pwrgit/shared";
import {
  launchApp,
  readActiveProfile,
  type AppHandle
} from "./fixtures/electron-app";
import { createForgeFixture } from "./fixtures/forge-fixture";
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
    "Connect Git hosting and storage."
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

test("Forges hands a missing CLI its install commands, then notices the install", async () => {
  sandbox = createGitSandbox();
  const missing = { installed: false, loggedIn: false, owners: [], repositories: {} };
  const forges = createForgeFixture(sandbox, {
    github: { ...missing },
    gitlab: { ...missing },
    gitcafe: { ...missing }
  });
  handle = await launchApp({
    seedOnboarding: false,
    forgeFixturePath: forges.path
  });
  const { window } = handle;
  // Scoped to the strip: the sidebar's lens filter behind the scrim is a
  // tablist too.
  const chip = (kind: (typeof FORGE_KINDS)[number]) =>
    window.getByRole("tablist", { name: "Forges" }).getByRole("tab", {
      name: new RegExp(`^${forgeProduct(kind).label}:`)
    });
  const chipState = (kind: (typeof FORGE_KINDS)[number]) =>
    chip(kind).locator(".onboarding-wizard__lens-state");
  const panelCommands = window
    .getByRole("tabpanel")
    .locator(".onboarding-wizard__well-cmd");

  await nextButton(handle).click();
  await nextButton(handle).click();
  await expect(title(handle)).toHaveText(
    "Connect Git hosting and storage."
  );

  // The app and this runner share a machine, so the commands the step chose
  // are this process's platform's.
  for (const kind of FORGE_KINDS) {
    await chip(kind).click();
    if (forgeProduct(kind).authentication === "repo-token") {
      await expect(chipState(kind)).toHaveText("Add token");
      await expect(panelCommands).toHaveCount(0);
      await expect(window.getByRole("tabpanel")).toContainText(
        "save the exact remote and repo token in Settings"
      );
      await expect(
        window.getByRole("tabpanel").getByRole("button", { name: "Token guide ↗" })
      ).toBeVisible();
      continue;
    }
    await expect(chipState(kind)).toHaveText("Not installed");
    await expect(panelCommands).toHaveText([
      ...forgeInstall(kind, process.platform).steps
    ]);
  }

  // Installed from a terminal, then Back and forward again. Main re-reads the
  // fixture on every probe, so this is exactly the round trip that used to
  // keep showing the pre-install answer: arriving at the step must force one.
  forges.config.hosts.gitlab = { ...missing, installed: true };
  forges.write();
  // The wizard's own Back — the window's history control is also "Back".
  await window
    .locator(".onboarding-wizard__footer")
    .getByRole("button", { name: "Back" })
    .click();
  await nextButton(handle).click();

  // Detected now, so it sorts first, and it is what needs doing next.
  await expect(
    window.getByRole("tablist", { name: "Forges" }).getByRole("tab").first()
  ).toHaveAccessibleName(
    "GitLab: Signed out"
  );
  await expect(chip("gitlab")).toHaveAttribute("aria-selected", "true");
  await expect(panelCommands).toHaveText("glab auth login");
  await expect(chipState("github")).toHaveText("Not installed");

  // And without leaving the step: signed in from the terminal, then Re-check.
  forges.config.hosts.gitlab = { ...missing, installed: true, loggedIn: true };
  forges.write();
  await window.getByRole("button", { name: "Re-check" }).click();
  await expect(chipState("gitlab")).toHaveText("Connected");
  await expect(chip("gitlab")).toHaveAttribute("aria-selected", "true");
  await expect(window.getByRole("tabpanel")).toContainText(
    "glab is installed and signed in."
  );
});
