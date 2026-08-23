import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";

/**
 * U1 verification: the app boots a single window with the React root mounted.
 * The second spec launches two isolated instances concurrently so moving the
 * userData override below app.requestSingleInstanceLock() cannot silently make
 * local E2E collapse into an already-running Pwr app.
 */
test("boots a single window with #root mounted", async () => {
  const handle = await launchApp();
  try {
    // One window per profile: the title carries the booted profile's name.
    expect(await handle.window.title()).toMatch(/^PwrGit( — .+)?$/);
    expect(handle.app.windows().length).toBe(1);
    // `ping` is deliberately transport-only: prove the exposed preload API,
    // IPC dispatcher, command bus, and main handler complete one round trip.
    expect(
      await handle.window.evaluate(() =>
        window.pwrgit.dispatch("ping", undefined)
      )
    ).toEqual({ ok: true, value: "pong" });
  } finally {
    await handle.cleanup();
  }
});

test("isolates built-app identity and single-instance locks", async () => {
  let first: AppHandle | null = null;
  let second: AppHandle | null = null;
  const inheritedRendererUrl = process.env.ELECTRON_RENDERER_URL;
  // Model a test command spawned by another electron-vite app. A data URL
  // makes a sanitizer regression fail quickly and without a dev server.
  process.env.ELECTRON_RENDERER_URL =
    'data:text/html,<div id="root">foreign renderer</div>';
  try {
    first = await launchApp();
    second = await launchApp();

    const identities = await Promise.all(
      [first, second].map(async ({ app, window }) => ({
        main: await app.evaluate(({ app: electronApp }) => ({
          name: electronApp.getName(),
          userData: electronApp.getPath("userData"),
          hasSingleInstanceLock: electronApp.hasSingleInstanceLock()
        })),
        rendererUrl: window.url()
      }))
    );

    expect(identities.map(({ main }) => main.name)).toEqual([
      "PwrGit",
      "PwrGit"
    ]);
    expect(identities[0]?.main.userData).not.toBe(
      identities[1]?.main.userData
    );
    expect(
      identities.every(({ main }) => main.hasSingleInstanceLock)
    ).toBe(true);
    expect(
      identities.every(({ rendererUrl }) => rendererUrl.startsWith("file:"))
    ).toBe(true);
    expect(
      identities.every(({ rendererUrl }) =>
        rendererUrl.includes("/out/renderer/index.html")
      )
    ).toBe(true);
  } finally {
    await second?.cleanup();
    await first?.cleanup();
    if (inheritedRendererUrl === undefined) {
      delete process.env.ELECTRON_RENDERER_URL;
    } else {
      process.env.ELECTRON_RENDERER_URL = inheritedRendererUrl;
    }
  }
});
