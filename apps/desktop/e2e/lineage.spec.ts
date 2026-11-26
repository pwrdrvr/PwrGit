import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, branchRow, worktreeRow } from "./fixtures/steps";

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

test("detached repo with no branch refs still shows HEAD history", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("ref-less");
  sandbox.commit(repo.path, "second.txt", "second detached commit");
  const head = sandbox.git(repo.path, "rev-parse", "--short=7", "HEAD");
  // PowerLab materializes test targets at a commit and keeps only custom
  // refs/pwrlab markers. There is deliberately no local branch or remote.
  sandbox.git(repo.path, "update-ref", "refs/pwrlab/test-target", "HEAD");
  sandbox.git(repo.path, "checkout", "--detach");
  sandbox.git(repo.path, "branch", "-D", "main");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "ref-less");
  await branchRow(window, `detached@${head}`).first().click();

  await expect(
    window.locator(".graph-row", { hasText: "second detached commit" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    window.locator(".graph-row", { hasText: "initial commit" })
  ).toBeVisible();
  await expect(window.locator(".graph-empty")).toBeHidden();
});

test("lineage failures surface a toast instead of looking like empty history", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("broken-history");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "broken-history");
  await branchRow(window, "main").first().click();
  await expect(
    window.locator(".graph-row", { hasText: "initial commit" })
  ).toBeVisible({ timeout: 20_000 });

  // Make the next, differently-scoped graph request fail after the repo has
  // already loaded. The renderer must not silently translate that Result into
  // "No commits." Keep .git in place: Windows watchers can prevent renaming
  // it, and removing it races the missing-worktree guard instead of testing
  // a Git failure. An invalid repo-local config makes every Git read fail.
  writeFileSync(join(repo.path, ".git", "config"), "[invalid fixture config\n");
  await window.locator(".only-me").click();

  const toast = window.locator(".app-toast", { hasText: "History unavailable" });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/bad config line 1/i);
  await expect(toast.getByRole("button", { name: "Logs" })).toBeVisible();
  await expect(window.locator(".graph-empty")).toBeHidden();
});

test("command palette finds and opens commits from the current timeline", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  const repo = s.makeRepo("commit-search");
  s.commit(repo.path, "terminal.txt", "feat: searchable remote terminals");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "commit-search");
  await branchRow(window, "main").first().click();

  const targetRow = window.locator(".graph-row", {
    hasText: "feat: searchable remote terminals"
  });
  await expect(targetRow).toBeVisible({ timeout: 20_000 });
  const shortHash = await targetRow.locator(".commit-sha-chip").textContent();

  await window.keyboard.press("Control+K");
  await window.locator(".overlay-search input").fill("remote terminals");
  const hit = window.locator(".overlay-result", {
    hasText: "feat: searchable remote terminals"
  });
  await expect(hit).toBeVisible();
  await expect(hit.locator(".overlay-result__profile")).toHaveText(
    shortHash ?? ""
  );

  await hit.click();
  await expect(window.locator(".overlay-panel")).toBeHidden();
  await expect(targetRow).toHaveClass(/is-focused/);
  await expect(window.locator(".commit-tab__subject")).toHaveText(
    "feat: searchable remote terminals"
  );
});

test("command palette resolves full and short SHAs outside the loaded timeline", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  const repo = s.makeRepo("commit-sha-search");

  // Leave the object in the repository but remove every ref that would put it
  // into the lineage graph. Direct SHA lookup must not depend on graph scope.
  s.git(repo.path, "checkout", "-q", "-b", "hidden-object");
  s.commit(repo.path, "hidden.txt", "feat: find this dangling commit");
  const fullHash = s.git(repo.path, "rev-parse", "HEAD");
  s.git(repo.path, "checkout", "-q", "main");
  s.git(repo.path, "branch", "-D", "hidden-object");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "commit-sha-search");
  await branchRow(window, "main").first().click();
  await expect(window.locator(".graph-row").first()).toBeVisible({
    timeout: 20_000
  });

  await window.keyboard.press("Control+K");
  const input = window.locator(".overlay-search input");
  const hiddenHit = window.locator(".overlay-result", {
    hasText: "feat: find this dangling commit"
  });

  await input.fill(fullHash);
  await expect(hiddenHit).toBeVisible();
  await input.fill(fullHash.slice(0, 7));
  await expect(hiddenHit).toBeVisible();

  await hiddenHit.click();
  await expect(window.locator(".overlay-panel")).toBeHidden();
  await expect(window.locator(".commit-tab__subject")).toHaveText(
    "feat: find this dangling commit"
  );
});

test("remote-only branches use dashed lineage and ellipsized ref chips", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  const repo = s.makeRepo("remote-only-lineage");
  const branch =
    "agent/messaging-response-identity-labels-with-a-long-remote-name";

  // Model another machine's branch: its commit and origin/* tracking ref were
  // fetched, but no local refs/heads/* counterpart exists in this checkout.
  s.git(repo.path, "checkout", "-q", "-b", "remote-source");
  s.commit(repo.path, "remote.txt", "remote-only branch work");
  const remoteTip = s.git(repo.path, "rev-parse", "HEAD");
  s.git(repo.path, "checkout", "-q", "main");
  s.git(repo.path, "update-ref", `refs/remotes/origin/${branch}`, remoteTip);
  s.git(repo.path, "branch", "-D", "remote-source");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "remote-only-lineage");
  await branchRow(window, "main").first().click();
  await window.locator(".only-me").click();
  await expect(window.locator(".only-me")).toHaveText("All branches");

  const fullName = `origin/${branch}`;
  const row = window.locator(".graph-row", {
    hasText: "remote-only branch work"
  });
  const chip = row.locator(".ref-chip--remote", { hasText: fullName });
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await expect(row.locator('[stroke-dasharray="4 4"]')).toHaveCount(1);

  const truncation = await chip.locator(".ref-chip__name").evaluate((name) => {
    const style = getComputedStyle(name);
    return {
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      truncated: name.scrollWidth > name.clientWidth || name.scrollHeight > name.clientHeight
    };
  });
  expect(truncation).toEqual({
    overflow: "hidden",
    textOverflow: "ellipsis",
    truncated: true
  });
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
  const lineStarts = await row.evaluate((element) => ({
    sha: Math.round(
      element.querySelector(".commit-sha-chip")!.getBoundingClientRect().left
    ),
    meta: Math.round(
      element.querySelector(".commit-meta")!.getBoundingClientRect().left
    )
  }));
  expect(lineStarts.meta).toBe(lineStarts.sha);
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

  // WCAG 2.1 SC 1.4.13: content shown on hover has to be dismissible without
  // moving the pointer or focus. Dismissing from inside the card must also
  // not strand a keyboard user at the top of the document.
  await shaChip.focus();
  await expect(card).toBeVisible();
  await window.keyboard.press("Tab");
  await expect(shortCopy).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(shaChip).toBeFocused();
});

test("a pointer whipped down the SHA column leaves no context cards behind", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  const repo = s.makeRepo("hover-intent");
  for (let i = 0; i < 4; i += 1) {
    s.commit(repo.path, `f${i}.txt`, `passing commit ${i}`);
  }

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "hover-intent");
  await branchRow(window, "main").first().click();

  const chips = window.locator(".commit-sha-chip");
  await expect(chips.first()).toBeVisible({ timeout: 20_000 });
  const centres = await chips.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })
  );
  expect(centres.length).toBeGreaterThan(3);

  const card = window.getByRole("dialog", { name: "Commit context" });
  const last = centres[centres.length - 1]!;

  // Record every card that reaches the DOM during the sweep. Polling between
  // moves would be self-defeating — each round trip parks the pointer on a
  // chip long enough to be a deliberate hover — and a single assertion after
  // the sweep silently stops catching the regression on any machine slow
  // enough to outlast the card's 400ms dismissal delay.
  await window.evaluate(() => {
    const probe = window as unknown as { __cardsSeen: number };
    probe.__cardsSeen = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof HTMLElement &&
            node.classList.contains("commit-context-card")
          ) {
            probe.__cardsSeen += 1;
          }
        }
      }
    }).observe(document.body, { childList: true });
  });

  // The SHA chips share one column, so anything travelling down the graph
  // crosses every trigger on the way to wherever it was actually going.
  await window.mouse.move(centres[0]!.x, centres[0]!.y - 200);
  for (const centre of centres) {
    await window.mouse.move(centre.x, centre.y);
  }
  await window.mouse.move(last.x + 320, last.y + 40);

  const cardsSeen = await window.evaluate(
    () => (window as unknown as { __cardsSeen: number }).__cardsSeen
  );
  expect(cardsSeen).toBe(0);
  await window.waitForTimeout(600);
  await expect(card).toBeHidden();

  // Stopping on a chip is what a card is for, and still works.
  await window.mouse.move(centres[1]!.x, centres[1]!.y);
  await expect(card).toBeVisible();
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
  const { app, window } = handle;
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(940, 700);
  });
  await expect
    .poll(() => window.evaluate(() => document.documentElement.clientWidth))
    .toBeLessThanOrEqual(940);
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

  // At the supported minimum window width, the gutter yields room to the
  // fixed SHA + age instead of pushing the age through the row's right edge.
  const mainWidth = await window
    .getByTestId("main")
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(mainWidth).toBeLessThan(300);
  const laneViewportWidth = await window
    .locator(".graph-lanes-clip")
    .first()
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(laneViewportWidth).toBeGreaterThanOrEqual(16);
  expect(laneViewportWidth).toBeLessThan(160);
  await expect(window.locator(".lane-scrollbar")).toBeVisible();
  const newestBranchRow = window.locator(".graph-row", {
    hasText: "work on b30"
  });
  await expect(newestBranchRow).toHaveCount(1);
  await expect(newestBranchRow.locator(".commit-time")).toBeVisible();

  // Row pressure is absorbed by the ellipsized subject, never the age. Every
  // duration must remain whole and within the row's padded content box.
  const durationLayout = await window.locator(".graph-row").evaluateAll((rows) =>
    rows.map((row) => {
      const duration = row.querySelector<HTMLElement>(".commit-time")!;
      const durationBox = duration.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const rowStyle = getComputedStyle(row);
      return {
        flexShrink: getComputedStyle(duration).flexShrink,
        fullyRendered: duration.scrollWidth <= duration.clientWidth,
        insideRightPadding:
          durationBox.right <= rowBox.right - parseFloat(rowStyle.paddingRight)
      };
    })
  );
  expect(durationLayout.length).toBeGreaterThan(0);
  expect(durationLayout).toEqual(
    durationLayout.map(() => ({
      flexShrink: "0",
      fullyRendered: true,
      insideRightPadding: true
    }))
  );
});

test("a commit tipped by many branches previews a bounded set and exposes every branch", async () => {
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
  const summary = headRow.getByRole("button", { name: /^Browse 9 refs at / });
  await expect(summary).toBeVisible({ timeout: 20_000 });
  const chips = headRow.locator(".ref-chips .ref-chip:visible");
  const named = await chips.count();
  expect(named).toBeGreaterThanOrEqual(1);
  expect(named).toBeLessThanOrEqual(2);
  await summary.press("Enter");
  const refs = headRow.getByRole("region", { name: /^Refs at / });
  await expect(refs.getByRole("listitem")).toHaveCount(9);
  await refs.getByRole("button", { name: "Actions for branch stale/b8" }).press("Enter");
  const actions = window.getByRole("menu", { name: "stale/b8 actions" });
  await expect(actions.getByRole("menuitem", { name: "Copy branch name" })).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(summary).toBeFocused();
  // And the subject stays readable.
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
  await expect(window.locator(".titlebar__branch-name")).toHaveText("feat/hop");
});

test("Lineage has its own paint root when Pull moves HEAD", async ({}, testInfo) => {
  test.skip(process.env.PWRGIT_LINEAGE_PAINT_ORACLE !== "1",
    "Requires Chromium paint tracing with the lab GPU");

  sandbox = createGitSandbox();
  const s = sandbox;
  const repo = s.makeRepoWithRemote("ledger");
  const epoch = Math.floor(Date.now() / 1000) - 3600;
  for (let i = 0; i < 60; i++) {
    s.commitEmptyAt(repo.path, `Ledger change ${i}`, epoch + i * 20);
  }
  for (let i = 0; i < 24; i++) {
    const branch = repo.addWorktree(`feature/ledger-${i}`);
    s.git(branch, "reset", "--hard", `main~${4 + i % 5}`);
    s.commitEmptyAt(branch, `Ledger side change ${i}`, epoch + 1190 + i);
  }
  const before = s.git(repo.path, "rev-parse", "HEAD");
  s.commitEmptyAt(repo.path, "Ledger incoming change", epoch + 1220);
  const after = s.git(repo.path, "rev-parse", "HEAD");
  s.git(repo.path, "push", "origin", "main");
  s.git(repo.path, "reset", "--hard", before);

  handle = await launchApp();
  const { app, window } = handle;
  await (await app.browserWindow(window)).evaluate((win) => win.setSize(1160, 740));
  await addRootAndExpand(window, handle, s, repo.name);
  await worktreeRow(window, "main").click();
  const initialHead = window.locator(`.graph-row--head[data-hash="${before}"]`);
  await expect(initialHead).toBeInViewport();
  await window.locator(".graph-card").evaluate(async (card) => {
    await Promise.all(card.getAnimations().map((animation) => animation.finished));
    await document.fonts.ready;
  });
  await expect(initialHead).not.toHaveClass(/is-flash/);

  const pull = window.locator(".wt-btn--pull");
  const scroll = window.locator(".graph-scroll");
  const width = () => scroll.evaluate((el) => el.clientWidth);
  const beforeWidth = await width();
  await pull.focus();
  const headCommitted = "Pull oracle HEAD committed";
  const head = window.locator(`.graph-row--head[data-hash="${after}"]`);
  await scroll.evaluate((el, { after, headCommitted }) => {
    // The publish mark precedes React's synchronous commit. This mark ties it
    // to the first DOM update that actually displays the incoming commit.
    const observer = new MutationObserver(() => {
      if (!el.querySelector(`.graph-row--head[data-hash="${after}"]`)) return;
      performance.mark(headCommitted);
      observer.disconnect();
    });
    observer.observe(el, { subtree: true, childList: true, attributeFilter: ["class"] });
  }, { after, headCommitted });

  const captureReceipt = async () => {
    const card = window.locator(".remote-activity-popover");
    await expect(card).toContainText("Fast-forwarded");
    await expect(card.locator(".remote-activity__rail")).toBeVisible();
    await expect(card.getByRole("button", { name: "Dismiss status" })).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath("lineage-pull-receipt.png") });
  };

  const cdp = await window.context().newCDPSession(window);
  type TraceEvent = {
    name: string; pid: number; tid: number; ts: number;
    args?: { data?: { nodeName?: string } };
  };
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", ({ value }) => {
    for (const item of value) {
      const event = item as unknown as TraceEvent;
      if (event.name === "Paint" || event.name === "PrePaint" ||
        event.name === headCommitted || event.name.startsWith("PwrGit Lineage publish ")) {
        events.push(event);
      }
    }
  });
  try {
    await cdp.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing" });
    await window.keyboard.press("Enter");
    await Promise.all([captureReceipt(), expect(head).toBeInViewport()]);
    // Give Chromium a paint opportunity after the incoming HEAD is visible.
    await window.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const complete = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
    await cdp.send("Tracing.end");
    await complete;
  } finally {
    await cdp.detach();
  }
  expect(s.git(repo.path, "rev-parse", "HEAD")).toBe(after);
  expect(await width()).toBe(beforeWidth);
  await expect(pull).toBeFocused();

  const commit = events.find((event) => event.name === headCommitted);
  expect(commit, "the incoming HEAD reached the DOM").toBeDefined();
  const renderer = events.filter((event) => event.pid === commit!.pid && event.tid === commit!.tid)
    .sort((a, b) => a.ts - b.ts);
  const publish = renderer.findLast((event) =>
    event.ts <= commit!.ts && event.name.startsWith("PwrGit Lineage publish ")
  );
  expect(publish?.name).toMatch(/^PwrGit Lineage publish repo-change view=(\d+) target=\1$/);
  const frames = renderer.filter((event) => event.name === "PrePaint" && event.ts >= commit!.ts);
  expect(frames[0], "a frame followed the HEAD publish").toBeDefined();
  const paintRoots = renderer
    .filter((event) => event.name === "Paint" &&
      event.ts >= frames[0]!.ts && event.ts < (frames[1]?.ts ?? Infinity))
    .map((event) => event.args?.data?.nodeName);
  expect(paintRoots, "paint roots in the first frame after the HEAD publish").toContain("DIV class='graph-card'");
});

test("a narrow Lineage publish lays out the gutter and reveals lanes without reading a row width", async ({}, testInfo) => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("gutter-workbench");
  const focus = repo.addWorktree("feature/focus");
  sandbox.commit(focus, "widget.txt", "Adjust the widget");
  for (const branch of ["api", "build", "catalog", "docs", "events"]) {
    const worktree = repo.addWorktree(`feature/${branch}`);
    sandbox.commit(worktree, `${branch}.txt`, `Update ${branch}`);
  }
  for (let i = 0; i < 16; i += 1) {
    sandbox.git(repo.path, "commit", "--allow-empty", "-m", `Main line update ${i + 1}`);
  }
  const headHash = sandbox.git(focus, "rev-parse", "HEAD");
  handle = await launchApp();
  const { app, window } = handle;
  await window.emulateMedia({ reducedMotion: "reduce" });
  const native = await app.browserWindow(window);
  await native.evaluate((win) => {
    win.setSize(940, 720);
    win.setIgnoreMouseEvents(true);
  });
  await addRootAndExpand(window, handle, sandbox, repo.name);
  await window.evaluate(() => {
    const counter = globalThis as typeof globalThis & { laneWidthReads: number };
    counter.laneWidthReads = 0;
    const width = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
    Object.defineProperty(Element.prototype, "clientWidth", {
      ...width,
      get(this: Element) {
        if (this.classList.contains("graph-lanes-clip")) counter.laneWidthReads += 1;
        return width.get!.call(this);
      }
    });
  });

  const head = window.locator(`.graph-row[data-hash="${headHash}"]`);
  const bar = window.locator(".lane-scrollbar");
  const visibleDot = () => head.evaluate((row) => {
    const clip = row.querySelector(".graph-lanes-clip")!.getBoundingClientRect();
    const dot = row.querySelector(".graph-lanes > circle:last-of-type")!.getBoundingClientRect();
    const center = (dot.left + dot.right) / 2;
    return center >= clip.left && center <= clip.right;
  });
  await branchRow(window, "feature/focus").click();
  await expect(head).toHaveClass(/is-flash/);
  await expect(head).toBeInViewport();
  await expect(bar).toBeVisible();
  const naturalWidth = await head.locator(".graph-lanes").getAttribute("width");
  expect(Number(naturalWidth)).toBeLessThanOrEqual(160);
  const clipWidth = await head.locator(".graph-lanes-clip").evaluate((clip) => clip.getBoundingClientRect().width);
  expect(clipWidth).toBeLessThan(Number(naturalWidth));
  expect(await bar.evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(clipWidth);
  // The first automatic HEAD reveal has to pan even below the lane cap.
  await expect.soft.poll(visibleDot, { timeout: 2_000 }).toBe(true);
  await window.screenshot({ path: testInfo.outputPath("narrow-gutter.png") });

  // Opening a diff keeps this graph mounted behind it. A return to Lineage
  // should restore both scroll axes without a second reveal.
  await head.click();
  const scroller = window.locator(".graph-scroll");
  const offsets = async () => ({
    top: await scroller.evaluate((el) => el.scrollTop),
    left: await bar.evaluate((el) => el.scrollLeft)
  });
  const beforeDiff = await offsets();
  expect(beforeDiff.top).toBeGreaterThan(0);
  await window.locator(".file-row", { hasText: "widget.txt" }).click();
  await expect(window.locator(".diff-pane")).toBeVisible();
  await expect(bar).toBeHidden();
  await window.keyboard.press("Escape");
  await expect(bar).toBeVisible();
  await expect.poll(offsets).toEqual(beforeDiff);
  await expect.soft.poll(visibleDot, { timeout: 2_000 }).toBe(true);

  // A scroll notification queued before the pane hides can arrive while
  // the native bar reports zero. The plotted lanes must still track the bar.
  const interruptedPan = await head.evaluate(async (row) => {
    const pane = row.closest<HTMLElement>(".graph-wrap")!;
    const bar = pane.querySelector<HTMLElement>(".lane-scrollbar")!;
    const clip = row.querySelector(".graph-lanes-clip")!;
    const lanes = row.querySelector(".graph-lanes")!;
    const start = bar.scrollLeft;
    const x = lanes.getBoundingClientRect().left;
    clip.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 8 }));
    const display = pane.style.display;
    pane.style.display = "none";
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    pane.style.display = display;
    return { pan: bar.scrollLeft - start, shift: x - lanes.getBoundingClientRect().left };
  });
  expect.soft(interruptedPan.pan).toBeGreaterThan(0);
  expect.soft(interruptedPan.shift).toBeCloseTo(interruptedPan.pan);

  // Chromium can clamp a hidden scrollport on reopen without sending a
  // scroll event. The plotted lanes still have to match the native offset.
  const laneInset = () => head.evaluate((row) => {
    const clip = row.querySelector(".graph-lanes-clip")!.getBoundingClientRect();
    const lanes = row.querySelector(".graph-lanes")!.getBoundingClientRect();
    return lanes.left - clip.left;
  });
  expect(await laneInset()).toBeLessThan(0);
  await window.locator(".file-row", { hasText: "widget.txt" }).click();
  await expect(window.locator(".diff-pane")).toBeVisible();
  await expect(bar).toBeHidden();
  // Exercise the silent clamp even on Chromium builds that deliver a scroll
  // event for this transition. Keep the real native scrollbar and resize.
  await bar.evaluate((el) => {
    const controller = new AbortController();
    el.addEventListener("scroll", (event) => event.stopImmediatePropagation(), {
      capture: true,
      signal: controller.signal
    });
    el.addEventListener("resume-scroll-events", () => controller.abort(), { once: true });
  });
  await native.evaluate((win) => win.setSize(1360, 720));
  await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBeGreaterThan(1200);
  await window.keyboard.press("Escape");
  await expect(head).toBeVisible();
  await expect(bar).toBeHidden();
  await expect.poll(() => bar.evaluate((el) => el.scrollLeft)).toBe(0);
  await expect.soft.poll(laneInset, { timeout: 2_000 }).toBeCloseTo(0);
  await window.screenshot({ path: testInfo.outputPath("gutter-after-hidden-resize.png") });
  await bar.dispatchEvent("resume-scroll-events");
  await expect.poll(visibleDot).toBe(true);
  await native.evaluate((win) => win.setSize(940, 720));
  await expect(bar).toBeVisible();
  await expect.poll(() => bar.evaluate((el) => el.scrollLeft)).toBe(0);
  await window.locator(".graph-locate").press("Enter");
  await expect.soft.poll(visibleDot, { timeout: 2_000 }).toBe(true);
  await branchRow(window, "main").click();
  await expect(window.locator(".graph-row--head")).toContainText("Main line update 16");
  await expect.poll(() => bar.evaluate((el) => el.scrollLeft)).toBe(0);
  // The DOM sizes above are independent bounds reads. An app-side read of a
  // row's clientWidth in publish or resize reintroduces the forced layout.
  expect(await window.evaluate(() =>
    (globalThis as typeof globalThis & { laneWidthReads: number }).laneWidthReads
  )).toBe(0);
});

test("lane scrollbar stays above vertical scrolling and horizontal wheel pans lanes", async () => {
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
  const nativeWindow = await handle.app.browserWindow(window);
  await nativeWindow.evaluate((win) => {
    win.setSize(1200, 700);
    win.setIgnoreMouseEvents(true);
  });
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

  const bar = window.locator(".lane-scrollbar");
  const initialBarBox = await bar.boundingBox();
  expect(initialBarBox).not.toBeNull();
  const scroller = window.locator(".graph-scroll");
  for (const scrollTop of [136, 280, 0]) {
    await scroller.evaluate((el, y) => {
      el.scrollTop = y;
    }, scrollTop);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(scrollTop);
    const barBox = await bar.boundingBox();
    const scrollBox = await scroller.boundingBox();
    expect(barBox).not.toBeNull();
    expect(scrollBox).not.toBeNull();
    expect(barBox!.y).toBe(initialBarBox!.y);
    expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(scrollBox!.y);
  }
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

test("a focused branch behind its upstream draws the commits it is missing", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  // releases/1.0 is ahead 1 / behind 1 — the shape a release branch takes
  // mid-backport, and the one the trunk's remote-ahead handling never covered.
  s.makeRepoWithDivergedReleaseBranch("diverged-release");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "diverged-release");

  // Focus the release worktree: this is the branch the user is looking at, so
  // its fetched-but-unapplied work has to be on screen, not just counted.
  const release = branchRow(window, "releases/1.0");
  await expect(release).toBeVisible({ timeout: 20_000 });
  await release.click();

  const upstreamRow = window.locator(".graph-row", {
    hasText: "upstream release fix"
  });
  await expect(upstreamRow).toBeVisible({ timeout: 20_000 });
  // Fetched but not applied — same dashed lineage the trunk gets when
  // origin/main runs ahead of local main.
  await expect(upstreamRow.locator('[stroke-dasharray="4 4"]')).not.toHaveCount(0);
  await expect(
    upstreamRow.locator(".ref-chip--remote", { hasText: "origin/releases/1.0" })
  ).toBeVisible();

  // Our unpushed commit stays too: the divergence has to read as a fork.
  await expect(
    window.locator(".graph-row", { hasText: "prepare release" })
  ).toBeVisible();
});

test(
  "a focused branch two commits behind keeps one straight dashed train",
  async ({}, testInfo) => {
    sandbox = createGitSandbox();
    const s = sandbox;
    const repo = s.makeRepoWithRemote("linear-upstream");
    const branch = "fix/desktop-federation-audit-followthrough";
    const wt = repo.addWorktree(branch);
    s.commit(wt, "local.txt", "preserve local pin placement");
    const localTip = s.git(wt, "rev-parse", "HEAD");
    s.commit(wt, "remote-one.txt", "wait for native focus");
    s.commit(wt, "remote-two.txt", "start visual documents after synchronization");
    s.git(wt, "push", "-u", "origin", branch);
    s.git(wt, "reset", "--hard", localTip);

    handle = await launchApp({ theme: "light" });
    const { window } = handle;
    await addRootAndExpand(window, handle, s, "linear-upstream");
    await branchRow(window, branch).click();
    const rows = [
      "start visual documents after synchronization",
      "wait for native focus",
      "preserve local pin placement"
    ].map((subject) => window.locator(".graph-row", { hasText: subject }));
    for (const row of rows) await expect(row).toBeVisible();
    await window.screenshot({
      path: testInfo.outputPath("linear-upstream.png"),
      animations: "disabled"
    });
    const dots = await Promise.all(
      rows.map((row) =>
        row.locator(".graph-lanes > circle").last().getAttribute("cx")
      )
    );
    expect(dots[0]).toBe(dots[2]);
    expect(dots[1]).toBe(dots[2]);
    for (const row of rows.slice(0, 2)) {
      await expect(
        row.locator('.graph-lanes line[stroke-dasharray="4 4"]')
      ).not.toHaveCount(0);
      await expect(
        row.locator(".graph-lanes path[stroke-dasharray]")
      ).toHaveCount(0);
    }
    await expect(
      rows[2].locator('.graph-lanes line[stroke-dasharray="4 4"]')
    ).toHaveCount(1);
    await expect(
      rows[2].locator(".graph-lanes line:not([stroke-dasharray])")
    ).not.toHaveCount(0);
  }
);
