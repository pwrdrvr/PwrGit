import { createServer, type Server, type Socket } from "node:net";
import { expect, test } from "@playwright/test";
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


test("a pull that gets no answer says so, shows Git's command, and cancels", async () => {
  const { window } = await wedgedRepo("svc");

  const pull = window.getByRole("button", { name: /^Pull/ });
  await expect(pull).toBeVisible({ timeout: 20_000 });
  // This one hovers to summon the card, but the age gate still has to elapse
  // with the pointer where the hover left it — the same premise the tests
  // below rest on, and the same reason to let the window settle first.
  await ownThePointer(handle!);
  await pull.click();

  // Phase first: the toolbar has to stop saying "Pull" and start saying what
  // Git is doing, without waiting for output that is never coming.
  const busy = window.locator('.wt-btn[aria-busy="true"]');
  await expect(busy).toHaveAttribute("aria-label", "Fetching updates…", {
    timeout: 20_000
  });

  // The pointer has rested here since `pull.click()` — which is exactly how a
  // user arrives at this card, and why `hover()` cannot be what summons it:
  // with the pointer already inside the button, Playwright dispatches a bare
  // `mousemove` and no boundary event at all. The card has to come from the
  // operation's record reaching a trigger the pointer is already on.
  await busy.hover();
  const card = window.locator(".remote-activity-popover");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText("Pull · svc · main");
  // The two facts that turn "it's spinning" into something actionable.
  await expect(card).toContainText("git fetch --prune --progress");
  await expect(card).toContainText("Git has produced no output yet.");

  // The other way in, which the click leaves no room to observe above: leave
  // the button and come back. An operation this old is past the age gate, so
  // the hover is answered on the spot rather than after another wait.
  //
  // Leaving has to be a real exit, and it is aimed at an element rather than a
  // coordinate: the pointer must end up somewhere inert and provably outside
  // the toolbar, which a hard-coded point stops being the moment the layout or
  // the window size changes.
  await window.locator(".graph-toolbar__label").hover();
  await expect(card).toBeHidden({ timeout: 10_000 });
  await busy.hover();
  await expect(card).toBeVisible({ timeout: 10_000 });

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
 * The pointer never moves after the click, and nothing under it changes.
 *
 * Pull can lean on an accident to get here: swapping its glyph for the
 * spinner makes Chromium re-resolve hover, which React reports as a
 * `mouseenter` nobody made. Fetch keeps the same glyph spinning in place, so
 * that accident does not happen and no boundary event follows the click at
 * all. This test is deliberately the pull test *without* the `hover()` — if
 * the card only appears when something tells the popover where the pointer
 * is, it fails here.
 *
 * `WorktreeHeader.test.tsx` covers the wiring by answering `WHERE_THE_USER_IS`
 * for one element, because jsdom has no pointer to ask. What only a browser
 * can say is whether Chromium really leaves the pointer on a button it
 * re-rendered under — which is this test.
 */
test("a wedged fetch opens its card under the pointer that started it", async () => {
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
  await expect(card).toContainText("Git has produced no output yet.");

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
 * The premise first: the arming selector is `:focus-visible`, never `:focus`,
 * and the difference is a browser fact worth pinning down rather than
 * assuming. Chromium focuses a button on click WITHOUT making it
 * focus-visible, so the keyboard half above cannot leave anything behind that
 * would arm a card for a pointer which has walked off.
 *
 * Then the behaviour: walking away from a wedged fetch leaves the graph
 * uncovered. Note what this does NOT isolate — the record lands inside the
 * click (measured at ~30ms, faster than a pointer can leave), so the card is
 * armed while the pointer is still on the button and `onMouseLeave` is what
 * cancels it. That makes this a test of the outcome, not of the selector; the
 * assertion above is what holds the selector honest.
 */
test("a fetch clicked and walked away from leaves no card behind", async () => {
  const { window } = await wedgedRepo("svc");

  const fetch = window.locator('.wt-actions .wt-btn[aria-label="Fetch"]');
  await expect(fetch).toBeVisible({ timeout: 20_000 });
  await ownThePointer(handle!);
  await fetch.click();
  // Out into the graph, well before the age gate elapses. A named row rather
  // than coordinates: a fixed point silently stops meaning "away from the
  // toolbar" the moment the window size or the layout changes.
  await window.locator(".graph-row").first().hover();

  const busy = window.locator('.wt-btn[aria-busy="true"]');
  await expect(busy).toHaveAttribute("aria-label", "Fetching updates…", {
    timeout: 20_000
  });

  // The click left focus on the button — and left it NOT focus-visible.
  expect(
    await busy.evaluate((el) => ({
      focused: el === document.activeElement,
      focusVisible: el.matches(":focus-visible")
    }))
  ).toEqual({ focused: true, focusVisible: false });

  // Several times the age gate, with nothing to summon a card.
  await window.waitForTimeout(4_000);
  await expect(window.locator(".remote-activity-popover")).toHaveCount(0);
});
