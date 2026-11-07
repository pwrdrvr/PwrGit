import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";

const launch = vi.hoisted(() => vi.fn(() => {
  throw new Error("Electron launch attempted");
}));
const lab = vi.hoisted(() => ({
  home: "/visible-e2e-oracle",
  runId: `mcp-e2e-${"a".repeat(32)}`
}));
vi.mock("@playwright/test", () => ({ _electron: { launch } }));
vi.mock("node:os", async importOriginal => ({
  ...await importOriginal(),
  homedir: () => lab.home
}));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal(),
  execFileSync: vi.fn(() => "VirtualMac2,1\n")
}));
// The pre-fix fixture reaches launch after creating userData. Keep this oracle
// entirely in Node, without creating files or launching any Electron process.
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal(),
  realpathSync: vi.fn(path => path === lab.home ? path : `${lab.home}/PwrLab/runs/${lab.runId}/checkout`),
  readFileSync: vi.fn(() => lab.runId),
  mkdtempSync: vi.fn(() => "/unused-e2e-oracle"),
  writeFileSync: vi.fn()
}));

import { launchApp } from "../e2e/fixtures/electron-app";
import { visibleE2EHostAllowed } from "./visible-e2e-host";
import { readFileSync } from "node:fs";
import { join } from "node:path";

afterEach(() => {
  vi.unstubAllEnvs();
  launch.mockClear();
  vi.mocked(readFileSync).mockReset();
});

it("refuses an unowned host before Electron, regardless of generic CI", async () => {
  // No GitHub runner context and no lab-owned staged checkout: flags cannot
  // authorize windows on the operator's desktop. The sentinel is the oracle;
  // even pre-fix code cannot launch Electron while this test runs.
  vi.stubEnv("GITHUB_ACTIONS", "");
  // All other observations model a valid lab job. Explicitly remove ownership
  // instead of relying on the machine running Vitest to lack the display lock.
  vi.mocked(readFileSync).mockImplementation(() => {
    throw Object.assign(new Error("No lab workload lock"), { code: "ENOENT" });
  });
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
