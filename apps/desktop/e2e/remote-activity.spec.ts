import { createServer, type Server, type Socket } from "node:net";
import { expect, test, type Locator } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand } from "./fixtures/steps";

let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;
let silentRemote: Server | null = null;
let held: Socket[] = [];

/**
 * A `git://` endpoint that accepts the connection and then says nothing.
 *
 * This is the failure the status surfaces exist for, reproduced exactly: TCP
 * succeeds, Git sends its request, and no byte ever comes back. `git fetch`
 * waits indefinitely and — because it never reaches the transfer — prints not
 * one line of `--progress` output. To the old UI that was a spinner; there was
 * no way to tell it apart from a large, healthy clone.
 *
 * A real network hang would be slower and far less reliable than this; an
 * upload-pack wrapper script would not run on the Windows E2E job.
 */
async function startSilentRemote(): Promise<number> {
  const server = createServer((socket) => {
    held.push(socket);
    socket.on("error", () => undefined);
  });
  silentRemote = server;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("silent remote did not bind a TCP port");
  }
  return address.port;
}

test.afterEach(async () => {
  // Drop the connections BEFORE closing the app. This spec is the only thing
  // in the suite that deliberately leaves a Git process blocked on a socket,
  // and Git for Windows runs git behind a launcher: terminating the process
  // PwrGit spawned can leave that grandchild alive, still blocked on this
  // read and still holding the stdio pipes it inherited — which `app.close()`
  // then waits on until Playwright's test timeout. Closing the socket first
  // makes the read fail, so Git exits on its own and there is nothing left to
  // wait for. Closing the app first passes on macOS and Linux and timed out
  // every run on the Windows E2E job.
  for (const socket of held) socket.destroy();
  held = [];
  silentRemote?.close();
  silentRemote = null;
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  sandbox?.cleanup();
  sandbox = null;
});

/**
 * A repository one commit behind a remote that accepts and then says nothing.
 *
 * Every test here needs the same wedge, and five hand-rolled copies of it is
 * five places to miss when the fixture changes.
 */
async function wedgedRepo(
  name: string,
  /**
   * Any other repository this test needs. It runs before the app launches,
   * because `addRootAndExpand` scans the folder once — a repo created after
   * that is simply not there.
   */
  alsoOnDisk?: (box: GitSandbox) => void
): Promise<{ box: GitSandbox; window: AppHandle["window"] }> {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoBehindRemote(name, { behindBy: 1 });
  const port = await startSilentRemote();
  box.git(
    repo.path,
    "remote",
    "set-url",
    "origin",
    `git://127.0.0.1:${port}/${name}.git`
  );
  alsoOnDisk?.(box);

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, name);
  return { box, window };
}

/**
 * Give a test sole ownership of the pointer before a gesture whose whole point
 * is where that pointer is left resting.
 *
 * Playwright's pointer is injected over CDP and never moves the host's real
 * cursor, so the two coexist — until Chromium recomputes hover after a layout
 * change and dispatches a synthetic "fake mouse move" at the position its
 * input pipeline last saw from the OS. That lands wherever the machine's
 * actual cursor happens to be, evicting the synthetic pointer parked on a
 * button: `:hover` really goes false, the popover's `onMouseLeave` correctly
 * cancels an armed card, and the test fails having proved nothing. Measured
 * here at roughly one run in four, with the window and the real cursor in
 * identical positions every launch — the timing of the fake move is the only
 * variable, so no amount of waiting fixes it.
 *
 * `setIgnoreMouseEvents` stops the OS delivering real mouse input to the
 * window at all. CDP injection goes straight to the renderer and is
 * unaffected, so the synthetic pointer becomes the only one the page has ever
 * seen, and a fake move can only re-dispatch where Playwright already is.
 */
async function ownThePointer(h: AppHandle): Promise<void> {
  await h.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setIgnoreMouseEvents(true);
  });
  await expect(h.window.locator(".graph-row").first()).toBeVisible({
    timeout: 20_000
  });
}


/**
 * A viewport point the pinned card does not cover, asked of the document
 * rather than assumed from a selector.
 *
 * Preference order is "the graph's empty space below the card", then beside
 * it, then above — the first that is both on the page and off the card wins.
 * `elementFromPoint` is what decides, so this cannot quietly return a point
 * inside the card the way a named element quietly stopped being clear of it.
 */
async function pointClearOfCard(
  window: AppHandle["window"]
): Promise<{ x: number; y: number }> {
  const box = await window.locator(".remote-activity-popover").boundingBox();
  expect(box, "the card must be on screen to measure around it").not.toBeNull();
  const rect = box!;
  const candidates = [
    { x: rect.x + rect.width / 2, y: rect.y + rect.height + 48 },
    { x: rect.x / 2, y: rect.y + rect.height / 2 },
    { x: rect.x + rect.width / 2, y: rect.y - 24 }
  ];
  const clear = await window.evaluate(
    (points: { x: number; y: number }[]) =>
      points.find((at) => {
        const el = document.elementFromPoint(at.x, at.y);
        return el !== null && el.closest(".remote-activity-popover") === null;
      }) ?? null,
    candidates
  );
  expect(
    clear,
    "no point around the card was both on the page and off the card"
  ).not.toBeNull();
  return clear!;
}

/**
 * Open the card's Git-output disclosure and return the block inside it.
 *
 * Collapsed while an operation looks healthy, because Git's progress output is
 * `\r`-rewritten and reproducing it live was the card's largest source of
 * churn. It opens itself once that output IS the finding — a quiet warning, a
 * failure, a cancel — and these tests reach it before the 20s quiet threshold,
 * so they ask for it explicitly.
 */
async function gitOutput(card: Locator): Promise<Locator> {
  const evidence = card.locator(".remote-activity__evidence");
  await expect(evidence).toBeVisible({ timeout: 10_000 });
  if ((await evidence.evaluate((el: HTMLDetailsElement) => el.open)) === false) {
    await evidence.locator("summary").click();
  }
  return evidence.locator(".remote-activity__output");
}

test("a pull that gets no answer says so, shows Git's command, and cancels", async () => {
  const { window } = await wedgedRepo("svc");

  const pull = window.getByRole("button", { name: /^Pull/ });
  await expect(pull).toBeVisible({ timeout: 20_000 });
  await ownThePointer(handle!);
  await pull.click();

  // The click is what opens it: no age gate, no hover, and no wait for main to
  // register the operation.
  const card = window.locator(".remote-activity-popover");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText("Pull · svc · main");

  // Phase next: the toolbar has to stop saying "Pull" and start saying what
  // Git is doing, without waiting for output that is never coming.
  const busy = window.locator('.wt-btn[aria-busy="true"]');
  await expect(busy).toHaveAttribute("aria-label", "Fetching updates…", {
    timeout: 20_000
  });

  // The three facts that turn "it's spinning" into something actionable: what
  // step it is on, what it ran, and what Git has said — which is nothing, and
  // that is the finding.
  await expect(card.locator(".remote-activity__step")).toHaveText(
    /Fetching updates/,
    { timeout: 20_000 }
  );
  await expect(card).toContainText("git fetch --prune --progress");
  await expect(await gitOutput(card)).toContainText(
    "Git has produced no output yet."
  );

  // Walking away does NOT take it away. A hover card belongs to the pointer; a
  // card the user clicked open belongs to them. Aimed at an element rather
  // than a coordinate: the pointer must end up somewhere inert and provably
  // outside the toolbar, which a hard-coded point stops being the moment the
  // layout or the window size changes.
  await window.locator(".graph-toolbar__label").hover();
  await window.waitForTimeout(1_000);
  await expect(card).toBeVisible();

  // And a way out that is not force-quitting the app.
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(busy).toHaveCount(0, { timeout: 20_000 });
  await expect(window.locator(".sync-chip")).toContainText("pull canceled", {
    timeout: 10_000
  });
  // A cancel is the user's own decision, not a failure to report back at them.
  await expect(window.locator(".app-toast")).toHaveCount(0);
});

test("an operation in another repository stays visible and cancellable after you navigate away", async () => {
  const { window } = await wedgedRepo("stuck", (box) => {
    box.makeRepo("other");
  });
  const pull = window.getByRole("button", { name: /^Pull/ });
  await expect(pull).toBeVisible({ timeout: 20_000 });
  await pull.click();
  await expect(window.locator('.wt-btn[aria-busy="true"]')).toHaveCount(1, {
    timeout: 20_000
  });

  // Click into the other repository. Its toolbar is correctly silent about
  // work that is not its own — which is how a wedged fetch used to disappear.
  await window.locator(".repo-row", { hasText: "other" }).first().click();

  const toast = window.locator(".app-toast--activity");
  // Deliberately delayed: a card that appeared for every half-second refresh
  // would be a flicker rather than a status.
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(toast).toContainText("Pull · stuck · main");

  await toast.getByRole("button", { name: "Cancel" }).click();
  await expect(toast).toHaveCount(0, { timeout: 20_000 });
});

/**
 * Fetch, which used to be the hardest case and is now the plainest.
 *
 * Fetch draws the same `<RefreshGlyph/>` busy or idle — the arrow spins in
 * place — so nothing under the pointer is replaced and the click is followed
 * by no boundary event at all. Reaching the card through the pointer meant
 * asking the DOM where the user was; reaching it through the click means not
 * having to ask. Deliberately no `hover()` anywhere below.
 */
test("a wedged fetch opens its card from the click that started it", async () => {
  const { window } = await wedgedRepo("svc");

  // The sidebar has Fetch buttons of its own, so reach for the toolbar's.
  const fetch = window.locator('.wt-actions .wt-btn[aria-label="Fetch"]');
  await expect(fetch).toBeVisible({ timeout: 20_000 });
  await ownThePointer(handle!);
  await fetch.click();

  const busy = window.locator('.wt-btn[aria-busy="true"]');
  await expect(busy).toHaveAttribute("aria-label", "Fetching updates…", {
    timeout: 20_000
  });

  // No second hover: the pointer is still resting where the click left it.
  const card = window.locator(".remote-activity-popover");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText("Fetch · svc · main");
  await expect(card).toContainText("git fetch --prune --progress");
  await expect(await gitOutput(card)).toContainText(
    "Git has produced no output yet."
  );

  // Reachable means reachable all the way to the way out.
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(busy).toHaveCount(0, { timeout: 20_000 });
  await expect(window.locator(".sync-chip")).toContainText("fetch canceled", {
    timeout: 10_000
  });
});

/**
 * The same gap from the other side, and the same fix.
 *
 * Enter on Fetch leaves focus on a button that was not yet a trigger when
 * `focusin` fired, and no second focus event follows — so the keyboard had no
 * way to the card at all, and through it no way to Cancel.
 *
 * `press()` moves no mouse, so nothing here can pass by way of `:hover`; and
 * Tab must hand focus INTO the card rather than on to Pull, or the only
 * control that stops a wedged fetch stays mouse-only.
 */
test("a wedged fetch opens its card for the keyboard, and Tab reaches Cancel", async () => {
  const { window } = await wedgedRepo("svc");

  const fetch = window.locator('.wt-actions .wt-btn[aria-label="Fetch"]');
  await expect(fetch).toBeVisible({ timeout: 20_000 });
  await ownThePointer(handle!);
  await fetch.press("Enter");

  const busy = window.locator('.wt-btn[aria-busy="true"]');
  await expect(busy).toHaveAttribute("aria-label", "Fetching updates…", {
    timeout: 20_000
  });

  const card = window.locator(".remote-activity-popover");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText("Fetch · svc · main");

  const cancel = card.getByRole("button", { name: "Cancel" });
  await window.keyboard.press("Tab");
  await expect(cancel).toBeFocused();

  await window.keyboard.press("Enter");
  await expect(busy).toHaveCount(0, { timeout: 20_000 });
  await expect(window.locator(".sync-chip")).toContainText("fetch canceled", {
    timeout: 10_000
  });
});

/**
 * Two things at once, because they share a launch.
 *
 * The premise first: the HOVER path's arming selector is `:focus-visible`,
 * never `:focus`, and the difference is a browser fact worth pinning down
 * rather than assuming. Chromium focuses a button on click WITHOUT making it
 * focus-visible, so the keyboard half of `WHERE_THE_USER_IS` cannot resurrect
 * a card for a pointer that has walked off.
 *
 * Then the behaviour, which is the inverse of what it used to be: a card
 * opened by a click is NOT the pointer's to take away. Walking off the button
 * leaves it standing, and only an explicit dismissal ends it — here, a click
 * out in the graph, which must also still land where it was aimed.
 */
test("a fetch clicked and walked away from keeps its card until a click elsewhere", async () => {
  const { window } = await wedgedRepo("svc");

  const fetch = window.locator('.wt-actions .wt-btn[aria-label="Fetch"]');
  await expect(fetch).toBeVisible({ timeout: 20_000 });
  await ownThePointer(handle!);
  await fetch.click();

  const busy = window.locator('.wt-btn[aria-busy="true"]');
  await expect(busy).toHaveAttribute("aria-label", "Fetching updates…", {
    timeout: 20_000
  });

  const card = window.locator(".remote-activity-popover");
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Somewhere the pointer can go that is provably not the card, derived from
  // the card's own geometry and then confirmed against the document.
  //
  // Naming an element instead is what broke this test: a pinned card sits over
  // the top of the graph, and WHICH element it covers depends on the window
  // size. `.graph-row` first is clear on macOS and behind the card on CI's
  // shorter Linux and Windows windows, where Playwright quite correctly
  // refused to hover through a dialog — and the failure read as a 30s timeout
  // on the row rather than as "the card is in the way".
  //
  // Below the card is preferred because that is the graph's own empty space,
  // where a click selects nothing and so cannot be what dismissed the card.
  // The fallbacks exist so a window too short for that fails the assertion
  // rather than the geometry.
  const away = await pointClearOfCard(window);
  await window.mouse.move(away.x, away.y);

  // The click left focus on the button — and left it NOT focus-visible.
  expect(
    await busy.evaluate((el) => ({
      focused: el === document.activeElement,
      focusVisible: el.matches(":focus-visible")
    }))
  ).toEqual({ focused: true, focusVisible: false });

  // Several times the old age gate, with the pointer nowhere near the button.
  await window.waitForTimeout(4_000);
  await expect(card).toBeVisible();
  await expect(card).toContainText("Fetch · svc · main");

  // A click there is the dismissal. That the click still lands where it was
  // aimed is asserted in `WorktreeHeader.test.tsx`, where the event's own
  // `defaultPrevented` can be read — proving it here would need a target that
  // does something observable AND is clear of the card at every window size,
  // and the second half of that is exactly what this test got wrong.
  await window.mouse.click(away.x, away.y);
  await expect(card).toHaveCount(0, { timeout: 10_000 });
});

/**
 * The half the card never had: what happened, after Git exits.
 *
 * A real fetch against a reachable remote, so it settles in well under the
 * second the old age gate withheld it for — the case that could not produce a
 * card at all. What it leaves behind is the receipt, and the receipt takes
 * itself away.
 */
test("a fetch that succeeds leaves a receipt that counts itself out", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepoBehindRemote("svc", { behindBy: 2 });
  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "svc");

  const fetch = window.locator('.wt-actions .wt-btn[aria-label="Fetch"]');
  await expect(fetch).toBeVisible({ timeout: 20_000 });
  await ownThePointer(handle);
  await fetch.click();

  const card = window.locator(".remote-activity-popover");
  await expect(card).toContainText("Fetched", { timeout: 20_000 });
  // And it is a *row*, not a sentence that replaced one: the receipt is what
  // the running card became, which is the whole of why it needs no re-reading.
  await expect(card.locator(".remote-activity__step")).toHaveText(/Fetched/);
  // Nothing left to stop, and a way out that does not depend on seeing the
  // rail drain — which is what a reader with prefers-reduced-motion gets.
  await expect(card.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Dismiss status" })).toBeVisible();
  await expect(card.locator(".remote-activity__rail")).toBeVisible();

  // And then it goes, without being asked twice.
  await expect(card).toHaveCount(0, { timeout: 15_000 });
});
