import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // The suite drives a real Electron app + real git on a dev machine that may
  // be under load (historic flakes: fine isolated, timeouts in full runs when
  // the machine is busy). Generous ceilings + one retry absorb load spikes;
  // a genuinely broken test still fails, and a rescued one is reported as
  // "flaky" by the list reporter rather than hidden.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 1,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]]
});
