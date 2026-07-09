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
  for (let i = 0; i < 31; i += 1) {
    const b = `b${String(i).padStart(2, "0")}`;
    s.git(repo.path, "checkout", "-q", "-b", b);
    s.git(repo.path, "commit", "--allow-empty", "-m", `work on ${b}`);
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
