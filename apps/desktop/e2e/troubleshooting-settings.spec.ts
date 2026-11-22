import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

type View = "armed" | "idle" | "cpu-rules" | "notice-completed" | "notice-partial";

const mount = (page: Page, view: View): Promise<void> =>
  page.evaluate((name) => {
    (window as unknown as { __harness: { mount: (view: string) => void } }).__harness.mount(name);
  }, view);

/**
 * Settings › Troubleshooting and the startup-capture notice, in a Vite build of
 * the real Settings window and ToastHost against a fake bridge
 * (`harness/troubleshooting`). Hidden window; contrived paths only.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes each surface as a PNG there.
 */
test("Troubleshooting explains one-launch startup profiling and the 24-hour recording", async () => {
  test.setTimeout(120_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-troubleshooting-"));
  const html = await buildHarness("troubleshooting", join(out, "dist"));
  const app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
    ],
    // A fixed zone, so the stop time reads the same on every machine.
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: process.env["PWRGIT_HARNESS_WIDTH"] ?? "980", PWRGIT_HARNESS_HEIGHT: "1400", TZ: "America/Los_Angeles" })
  });
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: { ready: Promise<void> } }).__harness.ready);
    const resource = page.locator("section[aria-label='Resource Usage Recording']");
    const startup = page.locator("section[aria-label='Startup CPU Profiling']");
    const notice = page.locator("[data-toast-group='startup-cpu-profile']");

    const shoot = async (name: string, target: ReturnType<Page["locator"]>) => {
      if (!shots) return;
      await page.mouse.move(0, 0);
      await target.screenshot({ path: join(shots, `${name}.png`) });
    };

    await mount(page, "armed");
    await expect(resource).toBeVisible();
    await shoot("resource-armed", resource);
    await shoot("startup-armed", startup);
    await shoot("hot-cpu", page.locator("section[aria-label='Hot CPU Profiling']"));
    await expect(resource).toContainText("Stops automatically Sat, Nov 21, 10:43 AM");
    await expect(resource).toContainText("turns itself off 24 hours after it starts");
    await expect(startup.locator(".settings-panel__header")).toContainText("Next launch");
    await expect(startup).toContainText("the switch turns itself off as that launch starts");
    await expect(startup).not.toContainText("Remember to turn this back off");

    await mount(page, "cpu-rules");
    const hotCpu = page.locator("section[aria-label='Hot CPU Profiling']");
    const rules = hotCpu.getByRole("group", { name: "Capture rules" });
    await expect(rules).toBeVisible();
    await expect(rules).toContainText("15 consecutive 2 s samples (30 s)");
    await shoot("hot-cpu-two-rules", hotCpu);
    await rules.getByRole("radio", { name: "Sustained" }).press("ArrowLeft");
    await expect(rules.getByRole("radio", { name: "Spike" })).toBeChecked();
    await rules.getByRole("combobox", { name: "Spike duration" }).selectOption("1000");
    await expect(rules).toContainText("30 consecutive 1 s samples (30 s)");
    await rules.getByRole("checkbox", { name: "High CPU" }).uncheck();
    const last = rules.getByRole("checkbox", { name: "Slow burn" });
    await last.press("Space");
    await expect(last).toBeChecked();
    await expect(rules.getByRole("status")).toContainText("At least one rule stays on");

    await mount(page, "idle");
    await expect(resource.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await shoot("resource-idle", resource);
    await shoot("startup-idle", startup);
    await expect(resource).not.toContainText("Stops automatically");
    await expect(startup).toContainText("One launch only");

    for (const view of ["notice-completed", "notice-partial"] as const) {
      await mount(page, view);
      await expect(notice).toBeVisible();
      await shoot(view, notice);
      await expect(notice).toContainText("startup-cpu-2026-11-20-1043-a1b2c3");
      await expect(notice.getByRole("button", { name: "Copy notice" })).toBeVisible();
    }
    await expect(notice).toContainText("Startup CPU profile partly saved");
    await expect(notice).toContainText("renderer.cpuprofile missing");
  } finally {
    await app.close();
  }
});
