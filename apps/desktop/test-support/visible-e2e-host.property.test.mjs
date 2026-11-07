import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";

const launch = vi.hoisted(() => vi.fn(() => {
  throw new Error("Electron launch attempted");
}));
vi.mock("@playwright/test", () => ({ _electron: { launch } }));
// The pre-fix fixture reaches launch after creating userData. Keep this oracle
// entirely in Node, without creating files or launching any Electron process.
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal(),
  mkdtempSync: vi.fn(() => "/unused-e2e-oracle"),
  writeFileSync: vi.fn()
}));

import { launchApp } from "../e2e/fixtures/electron-app";
import { visibleE2EHostAllowed } from "./visible-e2e-host";
import { join } from "node:path";

afterEach(() => {
  vi.unstubAllEnvs();
  launch.mockClear();
});

it("refuses an unowned host before Electron, regardless of generic CI", async () => {
  // No GitHub runner context and no lab-owned staged checkout: flags cannot
  // authorize windows on the operator's desktop. The sentinel is the oracle;
  // even pre-fix code cannot launch Electron while this test runs.
  vi.stubEnv("GITHUB_ACTIONS", "");
  await fc.assert(fc.asyncProperty(fc.string(), async ci => {
    vi.stubEnv("CI", ci);
    await expect(launchApp()).rejects.toThrow("PwrSuiteLab");
    expect(launch).not.toHaveBeenCalled();
  }));
});

const runId = fc.uint8Array({ minLength: 16, maxLength: 16 })
  .map(bytes => `mcp-e2e-${Buffer.from(bytes).toString("hex")}`);

it("requires the VM and the current display owner's exact staged checkout", () => {
  fc.assert(fc.property(runId, runId, (owner, other) => {
    fc.pre(owner !== other);
    const home = "/lab-user";
    const host = {
      platform: "darwin", model: "VirtualMac2,1", home, lockRunId: owner,
      checkout: join(home, "PwrLab", "runs", owner, "checkout")
    };
    expect(visibleE2EHostAllowed(host)).toBe(true);
    expect(visibleE2EHostAllowed({ ...host, model: "Mac16,10" })).toBe(false);
    expect(visibleE2EHostAllowed({ ...host, lockRunId: other })).toBe(false);
    expect(visibleE2EHostAllowed({ ...host, checkout: `${host.checkout}-other` })).toBe(false);
    expect(visibleE2EHostAllowed({ ...host, lockRunId: "../../checkout" })).toBe(false);
  }));
});

it("preserves GitHub Actions across its supported runner platforms", async () => {
  fc.assert(fc.property(fc.constantFrom("darwin", "linux", "win32"), platform => {
    expect(visibleE2EHostAllowed({
      githubActions: "true", platform, model: "", home: "", checkout: "", lockRunId: ""
    })).toBe(true);
  }));
  vi.stubEnv("GITHUB_ACTIONS", "true");
  await expect(launchApp()).rejects.toThrow("Electron launch attempted");
  expect(launch).toHaveBeenCalledOnce();
});
