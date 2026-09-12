import { describe, expect, it, vi } from "vitest";
import {
  ForgeStatusService,
  type ForgeProbe,
  type ForgeStatusHost
} from "./status";

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

/** A probe holding a credential for exactly these hosts, recording every host
 *  it was actually asked about. */
function hostProbe(
  kind: "github" | "gitlab",
  signedInAt: string[],
  asked: string[] = []
): ForgeProbe & { asked: string[] } {
  return {
    kind,
    cli: kind === "github" ? "gh" : "glab",
    asked,
    installed: async () => true,
    loggedIn: async (host: string) => {
      asked.push(host);
      return signedInAt.includes(host);
    }
  };
}

function host(
  kind: "github" | "gitlab",
  name: string,
  enabled = true
): ForgeStatusHost {
  return { kind, host: name, enabled };
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

  it("a forced read never adopts a probe that began before it", async () => {
    // The point of forcing is to observe something the caller just did, so a
    // probe already in flight cannot answer it.
    let loggedIn = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let probes = 0;
    // Each probe answers with the state as of when IT started, which is what
    // makes "adopted a probe that began earlier" observable.
    const snapshots: boolean[] = [];
    const service = new ForgeStatusService({
      probes: [
        {
          kind: "github",
          cli: "gh",
          installed: async () => {
            snapshots[probes] = loggedIn;
            probes += 1;
            if (probes === 1) await gate;
            return true;
          },
          loggedIn: async () => snapshots[probes - 1] ?? false
        }
      ]
    });

    const slow = service.list();
    // The user signs in while that first probe is still running.
    loggedIn = true;
    const forced = service.list({ force: true });
    release?.();

    await expect(slow).resolves.toMatchObject([{ loggedIn: false }]);
    await expect(forced).resolves.toMatchObject([{ loggedIn: true }]);
    expect(probes).toBe(2);
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

  it("is signed in when any enabled host is, not only the SaaS one", async () => {
    // The bug this replaces: probing gitlab.com alone reported "Signed out" on a
    // machine signed in to a self-managed instance, and the settings pane said so
    // directly under a Hosts row naming that instance's account.
    const glab = hostProbe("gitlab", ["gitlab.example.com"]);
    const service = new ForgeStatusService({
      probes: [glab],
      hosts: () => [host("gitlab", "gitlab.com"), host("gitlab", "gitlab.example.com")]
    });

    const [gitlab] = await service.list();

    expect(gitlab?.loggedIn).toBe(true);
    expect(gitlab?.hosts).toEqual([
      { host: "gitlab.com", enabled: true, loggedIn: false },
      { host: "gitlab.example.com", enabled: true, loggedIn: true }
    ]);
  });

  it("never probes a host the user switched off", async () => {
    // "Off" has to mean off at the transport, not just in the UI: a switch that
    // still spawns the CLI is a setting that lies.
    const gh = hostProbe("github", ["github.internal"]);
    const service = new ForgeStatusService({
      probes: [gh],
      hosts: () => [host("github", "github.internal", false)]
    });

    const [github] = await service.list();

    expect(gh.asked).toEqual([]);
    expect(github?.loggedIn).toBe(false);
    // Not collapsed into "signed out": the switch is what says why, and the
    // renderer needs the difference to send the user to the right place.
    expect(github?.hosts).toEqual([
      { host: "github.internal", enabled: false, loggedIn: false }
    ]);
  });

  it("does not report connected off the back of a host that is switched off", async () => {
    const service = new ForgeStatusService({
      probes: [hostProbe("github", ["github.com", "github.internal"])],
      hosts: () => [
        host("github", "github.com", false),
        host("github", "github.internal", false)
      ]
    });

    await expect(service.list()).resolves.toMatchObject([{ loggedIn: false }]);
  });

  it("probes the SaaS hosts when no list is injected", async () => {
    // The default a caller that knows nothing about hosts gets, and what the E2E
    // fixture relies on. Completeness beyond this belongs to
    // `ForgeHosts.statusTargets()`, which is the only thing that can say whether
    // the user turned a host off.
    const gh = hostProbe("github", ["github.com"]);
    const glab = hostProbe("gitlab", []);
    const service = new ForgeStatusService({ probes: [gh, glab] });

    const [github] = await service.list();

    expect(gh.asked).toEqual(["github.com"]);
    expect(glab.asked).toEqual(["gitlab.com"]);
    expect(github?.loggedIn).toBe(true);
  });

  it("probes exactly the hosts it is given, and nothing else", async () => {
    const gh = hostProbe("github", ["github.internal"]);
    const service = new ForgeStatusService({
      probes: [gh],
      hosts: () => [host("github", "github.internal")]
    });

    const [github] = await service.list();

    expect(gh.asked).toEqual(["github.internal"]);
    expect(github?.hosts.map((entry) => entry.host)).toEqual(["github.internal"]);
  });

  it("reports no hosts at all when the CLI is missing", async () => {
    // Listing hosts here would invite the reader to fix a sign-in when the
    // binary is what is absent.
    const service = new ForgeStatusService({
      probes: [probe("gitlab", false, false)],
      hosts: () => [host("gitlab", "gitlab.example.com")]
    });

    await expect(service.list()).resolves.toMatchObject([
      { installed: false, loggedIn: false, hosts: [] }
    ]);
  });

  it("keeps one host's unreachable instance from failing the others", async () => {
    const service = new ForgeStatusService({
      probes: [
        {
          kind: "gitlab",
          cli: "glab",
          installed: async () => true,
          loggedIn: async (name) => {
            if (name === "gitlab.broken") throw new Error("dial tcp: timeout");
            return true;
          }
        }
      ],
      hosts: () => [host("gitlab", "gitlab.broken"), host("gitlab", "gitlab.example.com")]
    });

    const [gitlab] = await service.list();

    expect(gitlab?.loggedIn).toBe(true);
    expect(gitlab?.hosts).toEqual([
      { host: "gitlab.broken", enabled: true, loggedIn: false },
      { host: "gitlab.example.com", enabled: true, loggedIn: true }
    ]);
  });

  it("wakes listeners when only the per-host detail moved", async () => {
    // Two enabled hosts, one switched off: the summary `loggedIn` does not
    // change, and comparing only the summary would leave the pane painting the
    // old host list.
    let second = true;
    const service = new ForgeStatusService({
      probes: [hostProbe("github", ["github.com", "github.internal"])],
      hosts: () => [
        host("github", "github.com"),
        host("github", "github.internal", second)
      ]
    });
    const listener = vi.fn();
    service.onChange(listener);

    await service.list({ force: true });
    expect(listener).toHaveBeenCalledTimes(1);

    second = false;
    await service.list({ force: true });

    expect(listener).toHaveBeenCalledTimes(2);
    await expect(service.list()).resolves.toMatchObject([{ loggedIn: true }]);
  });

  it("re-probes after invalidate rather than serving a pre-switch answer", async () => {
    let enabled = true;
    let now = 1_000;
    const service = new ForgeStatusService({
      probes: [hostProbe("github", ["github.internal"])],
      hosts: () => [host("github", "github.internal", enabled)],
      now: () => now
    });

    await expect(service.list()).resolves.toMatchObject([{ loggedIn: true }]);

    // The switch is an INPUT to the answer, so the TTL must not go on serving a
    // value computed under the old one.
    enabled = false;
    service.invalidate();

    await expect(service.list()).resolves.toMatchObject([{ loggedIn: false }]);
  });
});
