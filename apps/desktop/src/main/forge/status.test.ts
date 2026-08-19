import { describe, expect, it, vi } from "vitest";
import { ForgeStatusService, type ForgeProbe } from "./status";

function probe(
  kind: "github" | "gitlab",
  installed: boolean,
  loggedIn: boolean,
  spy?: { calls: number }
): ForgeProbe {
  return {
    kind,
    cli: kind === "github" ? "gh" : "glab",
    installed: async () => {
      if (spy !== undefined) spy.calls += 1;
      return installed;
    },
    loggedIn: async () => loggedIn
  };
}

describe("ForgeStatusService", () => {
  it("reports capabilities alongside availability", async () => {
    const service = new ForgeStatusService({
      probes: [probe("github", true, true), probe("gitlab", true, false)]
    });

    const [github, gitlab] = await service.list();

    expect(github).toMatchObject({ kind: "github", cli: "gh", installed: true, loggedIn: true });
    expect(gitlab).toMatchObject({ kind: "gitlab", cli: "glab", loggedIn: false });
    // GitLab has no batch commit-association endpoint; the UI needs to know.
    expect(github?.capabilities.batchedCommitAssociation).toBe(true);
    expect(gitlab?.capabilities.batchedCommitAssociation).toBe(false);
  });

  it("serves repeat reads from cache so a StrictMode double-mount costs one probe", async () => {
    const spy = { calls: 0 };
    let now = 1_000;
    const service = new ForgeStatusService({
      probes: [probe("github", true, true, spy)],
      now: () => now
    });

    await service.list();
    await service.list();
    await service.list();

    expect(spy.calls).toBe(1);
  });

  it("coalesces concurrent reads onto one probe", async () => {
    const spy = { calls: 0 };
    const service = new ForgeStatusService({ probes: [probe("github", true, true, spy)] });

    await Promise.all([service.list(), service.list(), service.list()]);

    expect(spy.calls).toBe(1);
  });

  it("re-probes a broken forge sooner than a working one", async () => {
    const spy = { calls: 0 };
    let now = 1_000;
    const service = new ForgeStatusService({
      probes: [probe("github", false, false, spy)],
      now: () => now,
      ttlMs: 300_000,
      failureTtlMs: 60_000
    });

    await service.list();
    now += 61_000;
    await service.list();

    expect(spy.calls).toBe(2);
  });

  it("treats a missing binary as a state, not an error", async () => {
    const service = new ForgeStatusService({
      probes: [
        {
          kind: "gitlab",
          cli: "glab",
          installed: async () => {
            throw new Error("spawn glab ENOENT");
          },
          loggedIn: async () => true
        }
      ]
    });

    await expect(service.list()).resolves.toMatchObject([
      { kind: "gitlab", installed: false, loggedIn: false }
    ]);
  });

  it("notifies only when availability actually changed", async () => {
    let loggedIn = false;
    const listener = vi.fn();
    const service = new ForgeStatusService({
      probes: [
        {
          kind: "github",
          cli: "gh",
          installed: async () => true,
          loggedIn: async () => loggedIn
        }
      ]
    });
    service.onChange(listener);

    await service.list({ force: true });
    expect(listener).toHaveBeenCalledTimes(1);

    // Same answer — the renderer must not be woken to repaint nothing.
    await service.list({ force: true });
    expect(listener).toHaveBeenCalledTimes(1);

    loggedIn = true;
    await service.list({ force: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying after unsubscribe", async () => {
    const listener = vi.fn();
    const service = new ForgeStatusService({ probes: [probe("github", true, true)] });
    const off = service.onChange(listener);
    await service.list({ force: true });
    off();
    await service.list({ force: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
