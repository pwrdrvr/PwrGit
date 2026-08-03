import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, branchRow } from "./fixtures/steps";

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

test("multi-lane lineage shows active branches and hides merged ones", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("gdemo");

  // An active worktree branch with unmerged work.
  const login = repo.addWorktree("feat/login");
  sandbox.commit(login, "login.txt", "start login flow");

  // A branch that gets merged into main → should be hidden by default.
  const tidy = repo.addWorktree("chore/tidy");
  sandbox.commit(tidy, "tidy.txt", "tidy imports");
  sandbox.git(repo.path, "merge", "--no-ff", "chore/tidy", "-m", "merge tidy");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "gdemo");
  await branchRow(window, "main").first().click();

  // Active view: the unmerged branch is drawn (its tip labelled); the merged
  // one is not in the active set, so the "hidden" hint appears.
  await expect(window.locator(".ref-chip", { hasText: "feat/login" })).toBeVisible({
    timeout: 20_000
  });
  await expect(window.locator(".graph-branches")).toContainText(
    "1 active branch"
  );
  const hint = window.locator(".graph-hidden-note");
  await expect(hint).toBeVisible();

  // Reveal everything — the hint disappears and the toggle flips label.
  await hint.locator("button").click();
  await expect(window.locator(".only-me")).toHaveText(/All branches/);
  await expect(hint).toBeHidden();
});

test("hovering an aligned commit SHA chip opens its context window", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  const repo = s.makeRepo("commit-context");
  const feature = repo.addWorktree("feat/context");
  s.commitAs(
    "someone@example.com",
    feature,
    "context.txt",
    "show commit context"
  );

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "commit-context");
  await branchRow(window, "main").first().click();

  const row = window.locator(".graph-row", { hasText: "show commit context" });
  await expect(row).toBeVisible({ timeout: 20_000 });

  const card = window.getByRole("dialog", { name: "Commit context" });
  // Ordinary row traversal stays quiet; context is an explicit hover target.
  await row.hover();
  await expect(card).toBeHidden();

  // Every SHA occupies the same fixed column, so the pointer can travel
  // vertically through history without hunting for each row's trigger.
  const shaChips = window.locator(".commit-sha-chip");
  const chipLefts = await shaChips.evaluateAll((chips) =>
    chips.map((chip) => Math.round(chip.getBoundingClientRect().left))
  );
  expect(new Set(chipLefts).size).toBe(1);

  const shaChip = row.locator(".commit-sha-chip");
  await expect(shaChip).toHaveText(/^[0-9a-f]{7}$/);
  await shaChip.hover();
  await expect(card).toBeVisible();
  // Leaving the row for the card must not make the interactive context window
  // disappear before its copy actions can be reached.
  await card.hover();
  await window.waitForTimeout(500);
  await expect(card).toBeVisible();
  // The pointer is now on the portalled card, not this row. Keep its visual
  // anchor highlighted until the card has actually dismissed.
  await expect(row).toHaveClass(/is-context-open/);
  await expect(card).toContainText("Commit context");
  await expect(card).toContainText("Someone Else");
  await expect(card).toContainText("someone@example.com");
  await expect(card).toContainText("Age");
  await expect(card).toContainText("Changes");
  await expect(card).toContainText("+1");
  await expect(card).toContainText("−0");
  // This row belongs to the sibling feature branch, not the worktree we are
  // viewing. Shared/off-head commits must not inherit the selected worktree's
  // branch context (in particular, a detached checkout must not label them
  // as detached).
  await expect(card).not.toContainText("Viewing branch");
  await expect(card).not.toContainText("Base branch");
  const shortCopy = card.getByRole("button", {
    name: "Copy short commit hash"
  });
  const fullCopy = card.getByRole("button", {
    name: "Copy full commit hash"
  });
  await expect(shortCopy).toBeVisible();
  await expect(fullCopy).toBeVisible();

  // Keyboard users enter the portalled card instead of tabbing past it and
  // leaving its controls to disappear behind the delayed dismissal.
  await shaChip.focus();
  await window.keyboard.press("Tab");
  await expect(shortCopy).toBeFocused();
  await window.waitForTimeout(500);
  await expect(card).toBeVisible();
  await window.keyboard.press("Tab");
  await expect(fullCopy).toBeFocused();

  // The card stays compact: its full OID is intentionally revealed only by
  // the nested copy tooltip, where it remains one pointer move away.
  const fullHash = s.git(feature, "rev-parse", "HEAD");
  await expect(card).not.toContainText(fullHash);
  await fullCopy.hover();
  await expect(
    window.getByRole("tooltip", { name: `Copy full SHA ${fullHash}` })
  ).toBeVisible();

  await row.click({ button: "right" });
  const menu = window.getByRole("menu", { name: "Commit actions" });
  await expect(menu).toBeVisible();
  await expect(card).toBeHidden();
  await expect(row).not.toHaveClass(/is-context-open/);
  await expect(menu.getByRole("menuitem", { name: "View changes" })).toBeFocused();
  await expect(
    menu.getByRole("menuitem", { name: "Copy short SHA" })
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Copy full SHA" })
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Copy commit message" })
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Copy author email" })
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Copy viewing branch" })
  ).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("switching worktrees anchors the lineage on that worktree's HEAD", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  const repo = s.makeRepo("locdemo");

  // An active branch of mine (worktree ⇒ always drawn).
  const login = repo.addWorktree("feat/login");
  s.commit(login, "l1.txt", "start login flow");

  // A branch authored by someone else (≠ the pinned profile identity), never
  // checked out on a branch-worktree ⇒ NOT in the active set — then a DETACHED
  // worktree parked at its tip. Its HEAD is on no drawn branch, so the graph
  // must widen its log to include it ("you are here" always resolves).
  s.git(repo.path, "checkout", "-q", "-b", "other/x");
  s.commitAs("rando@example.com", repo.path, "o1.txt", "other feature work");
  s.git(repo.path, "checkout", "-q", "main");
  s.git(
    repo.path,
    "worktree",
    "add",
    "--detach",
    join(s.worktreeRoot, "locdemo-det"),
    "other/x"
  );

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "locdemo");

  await branchRow(window, "feat/login").click();
  const headRow = window.locator(".graph-row--head");
  await expect(headRow).toContainText("start login flow", { timeout: 20_000 });

  await branchRow(window, "detached@").click();
  await expect(headRow).toContainText("other feature work", { timeout: 20_000 });
  // The locate affordance is present once a HEAD is resolved.
  await expect(window.locator(".graph-locate")).toBeVisible();
});

test("branch tips survive a busy trunk, and the navigator jumps to them", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  const repo = s.makeRepo("floody");
  const feat = repo.addWorktree("feat/buried");
  s.commit(feat, "f1.txt", "buried feature work");
  // Trunk races ahead — a flat `git log -n` window would be all trunk, and the
  // branch tip (older timestamp) would silently vanish from the graph.
  for (let i = 0; i < 30; i += 1) {
    s.git(repo.path, "commit", "--allow-empty", "-m", `trunk churn ${i}`);
  }

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "floody");
  await branchRow(window, "main").first().click();

  // The branch's commit is in the graph despite the trunk churn.
  await expect(
    window.locator(".graph-row", { hasText: "buried feature work" })
  ).toHaveCount(1, { timeout: 20_000 });

  // Navigator: lists the branch, and clicking it jumps the view to its tip.
  await window.locator(".graph-branches").click();
  const item = window.locator(".branch-pop__item", { hasText: "feat/buried" });
  await expect(item).toBeVisible();
  await item.click();
  await expect(
    window.locator(".graph-row", { hasText: "buried feature work" })
  ).toBeInViewport({ timeout: 20_000 });
});

test("caps drawn branches and clips the lane gutter on branch-heavy repos", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  const repo = s.makeRepo("many");
  // 31 active branches (each with an unmerged commit by "me") — more than the
  // draw cap (30) and far more concurrent lanes than the gutter viewport (10).
  // Pin strictly increasing commit dates so b30 is unambiguously the newest:
  // the draw cap keeps the 30 most recently committed branches, and a tight
  // same-second commit loop would leave the sort to arbitrary tie-breaking
  // (CI once dropped b30 itself, failing the visibility check below).
  const baseEpoch = Math.floor(Date.now() / 1000) - 3600;
  for (let i = 0; i < 31; i += 1) {
    const b = `b${String(i).padStart(2, "0")}`;
    s.git(repo.path, "checkout", "-q", "-b", b);
    s.commitEmptyAt(repo.path, `work on ${b}`, baseEpoch + i);
    s.git(repo.path, "checkout", "-q", "main");
  }

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "many");
  await branchRow(window, "main").first().click();

  // Cap reported: 30 drawn of 31 active; the navigator notes the overflow.
  await expect(window.locator(".graph-branches")).toContainText(
    "30 of 31 active branches",
    { timeout: 20_000 }
  );
  await window.locator(".graph-branches").click();
  await expect(window.locator(".branch-pop__more")).toContainText("+1 more");
  await window.keyboard.press("Escape");
  await window.locator(".branch-pop__backdrop").click({ force: true }).catch(() => undefined);

  // Gutter is clipped to 10 lanes (160px) with its own scrollbar — commit text
  // is NOT pushed off-screen by 30+ lanes.
  await expect(window.locator(".graph-lanes-clip").first()).toHaveCSS(
    "width",
    "160px"
  );
  await expect(window.locator(".lane-scrollbar")).toBeVisible();
  await expect(
    window.locator(".graph-row .commit-msg", { hasText: "work on b30" })
  ).toBeVisible();
});

test("a commit tipped by many branches caps its chips instead of flooding", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  const repo = s.makeRepo("tipfarm");
  // 8 stale branches all parked at HEAD — with main that's 9 tips on ONE
  // commit. Unbounded chips used to shove the commit message off-screen.
  for (let i = 1; i <= 8; i += 1) {
    s.git(repo.path, "branch", `stale/b${i}`);
  }

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "tipfarm");
  await branchRow(window, "main").first().click();

  const headRow = window.locator(".graph-row--head");
  await expect(headRow.locator(".ref-chip--more")).toHaveText("+7", {
    timeout: 20_000
  });
  // Two named chips + the overflow pill, and the subject stays readable.
  await expect(headRow.locator(".ref-chip")).toHaveCount(3);
  await expect(headRow.locator(".commit-msg")).toContainText("initial commit");
  await expect(headRow.locator(".commit-msg")).toBeInViewport();
});

test("a tip chip's worktree button jumps to that worktree", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  const repo = s.makeRepo("jumper");
  const feat = repo.addWorktree("feat/hop");
  s.commit(feat, "h.txt", "hop work");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "jumper");
  await branchRow(window, "main").first().click();

  // The feat/hop tip chip carries a worktree-jump button.
  const group = window.locator(".ref-group", { hasText: "feat/hop" });
  await expect(group.locator(".ref-wt")).toBeVisible({ timeout: 20_000 });
  await group.locator(".ref-wt").click();

  // Selection moved to that worktree: sidebar row selected + header follows.
  const selected = window.locator(".wt-row.is-selected");
  await expect(selected).toContainText("feat/hop", { timeout: 20_000 });
  await expect(window.locator(".wt-header__branch-name")).toHaveText("feat/hop");
});

test("horizontal wheel over the lane gutter pans lanes, not commits", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  const repo = s.makeRepo("panner");
  for (let i = 0; i < 14; i += 1) {
    const b = `lane/b${String(i).padStart(2, "0")}`;
    s.git(repo.path, "checkout", "-q", "-b", b);
    s.git(repo.path, "commit", "--allow-empty", "-m", `work ${b}`);
    s.git(repo.path, "checkout", "-q", "main");
  }

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "panner");
  await branchRow(window, "main").first().click();
  await expect(window.locator(".lane-scrollbar")).toBeVisible({ timeout: 20_000 });

  const before = await window
    .locator(".lane-scrollbar")
    .evaluate((el) => el.scrollLeft);
  await window.locator(".graph-lanes-clip").first().hover();
  await window.mouse.wheel(120, 0);
  await expect
    .poll(async () =>
      window.locator(".lane-scrollbar").evaluate((el) => el.scrollLeft)
    )
    .toBeGreaterThan(before);
});

test("All-branches scope reveals remote (teammate) branches", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  // A repo with an origin; a teammate's branch exists only on the remote.
  const repo = s.makeRepoBehindRemote("teamrepo", { behindBy: 1 });
  s.git(repo.path, "checkout", "-q", "-b", "team/rocket");
  s.commitAs("teammate@example.com", repo.path, "rocket.txt", "teammate rocket work");
  s.git(repo.path, "push", "-q", "origin", "team/rocket");
  s.git(repo.path, "checkout", "-q", "main");
  s.git(repo.path, "branch", "-q", "-D", "team/rocket");
  s.git(repo.path, "fetch", "-q", "origin");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "teamrepo");
  await branchRow(window, "main").first().click();

  // Active (mine only): the teammate's remote branch is not drawn.
  await expect(window.locator(".graph-toolbar")).toBeVisible({ timeout: 20_000 });
  await expect(
    window.locator(".ref-chip", { hasText: "team/rocket" })
  ).toHaveCount(0);

  // All: the remote branch appears, labelled with its origin/ name.
  await window.locator(".only-me").click();
  await expect(
    window.locator(".ref-chip", { hasText: "origin/team/rocket" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    window.locator(".graph-row", { hasText: "teammate rocket work" })
  ).toHaveCount(1);
});
