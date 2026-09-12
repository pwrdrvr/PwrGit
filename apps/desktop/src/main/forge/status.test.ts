import { describe, expect, it, vi } from "vitest";
import {
  ForgeStatusService,
  type ForgeProbe,
  type ForgeProbeTarget
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

/** Stands in for "the host the CLI itself considers default" — what an
 *  `assumed` target asks about, spelled `undefined` on the wire. */
const ANY_DEFAULT_HOST = "\u0000default";

/** A probe holding a credential for exactly these hosts, recording every host
 *  it was actually asked about (`undefined` for the CLI's default host). */
function hostProbe(
  kind: "github" | "gitlab",
  signedInAt: string[],
  asked: (string | undefined)[] = []
): ForgeProbe & { asked: (string | undefined)[] } {
  return {
    kind,
    cli: kind === "github" ? "gh" : "glab",
    asked,
    installed: async () => true,
    loggedIn: async (host: string | undefined) => {
      asked.push(host);
      return signedInAt.includes(host ?? ANY_DEFAULT_HOST);
    }
  };
}

function host(
  kind: "github" | "gitlab",
  name: string,
  enabled = true
): ForgeProbeTarget {
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

  it("asks the CLI about its own default host when no list is injected", async () => {
    // The default a caller that knows nothing about hosts gets, and what the E2E
    // fixture relies on. `undefined`, not "github.com": naming the host would
    // pass `--hostname github.com` and override an operator's `GH_HOST`, which
    // is what flipped a working Enterprise machine to "Signed out".
    const gh = hostProbe("github", [ANY_DEFAULT_HOST]);
    const glab = hostProbe("gitlab", []);
    const service = new ForgeStatusService({ probes: [gh, glab] });

    const [github] = await service.list();

    expect(gh.asked).toEqual([undefined]);
    expect(glab.asked).toEqual([undefined]);
    // The credential still counts toward the summary …
    expect(github?.loggedIn).toBe(true);
    // … but an assumed host has no row in Settings, so it is not reported as one.
    expect(github?.hosts).toEqual([]);
  });

  it("keeps an assumed host out of the report while counting its credential", async () => {
    // github.com is enumerated (a real row); gitlab.com is only assumed.
    const gh = hostProbe("github", ["github.com"]);
    const glab = hostProbe("gitlab", [ANY_DEFAULT_HOST]);
    const service = new ForgeStatusService({
      probes: [gh, glab],
      hosts: () => [
        host("github", "github.com"),
        { kind: "gitlab", host: "gitlab.com", enabled: true, assumed: true }
      ]
    });

    const [github, gitlab] = await service.list();

    expect(gh.asked).toEqual(["github.com"]);
    expect(glab.asked).toEqual([undefined]);
    expect(github?.hosts).toEqual([
      { host: "github.com", enabled: true, loggedIn: true }
    ]);
    expect(gitlab).toMatchObject({ loggedIn: true, hosts: [] });
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

  it("a forced read retires the cache, so a flipped switch is never waited out", async () => {
    let enabled = true;
    let now = 1_000;
    const service = new ForgeStatusService({
      probes: [hostProbe("github", ["github.internal"])],
      hosts: () => [host("github", "github.internal", enabled)],
      now: () => now
    });

    await expect(service.list()).resolves.toMatchObject([{ loggedIn: true }]);

    // The switch is an INPUT to the answer, so the TTL must not go on serving a
    // value computed under the old one. Forcing is the whole of that guarantee —
    // there is no separate invalidate() to forget.
    enabled = false;
    await expect(service.list({ force: true })).resolves.toMatchObject([
      { loggedIn: false }
    ]);
    // And the retired value is gone from the cache, not merely superseded.
    await expect(service.list()).resolves.toMatchObject([{ loggedIn: false }]);
  });

  it("never caches or broadcasts a pass a forced read has already retired", async () => {
    // The bug: nulling the cache made the stale pass compare as "changed", so it
    // wrote its pre-switch answer back AND woke the renderer with it, which
    // painted the state the user had just changed away from.
    let enabled = true;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Each pass answers with the state as of when IT started, which is what
    // makes "published a pass that began before the switch" observable.
    const snapshots: boolean[] = [];
    let passes = 0;
    const service = new ForgeStatusService({
      probes: [
        {
          kind: "github",
          cli: "gh",
          installed: async () => {
            snapshots[passes] = enabled;
            passes += 1;
            if (passes === 1) await gate;
            return true;
          },
          loggedIn: async () => snapshots[passes - 1] ?? false
        }
      ],
      hosts: () => [host("github", "github.internal", true)]
    });
    const listener = vi.fn();
    service.onChange(listener);

    const stale = service.list();
    enabled = false;
    const forced = service.list({ force: true });
    release?.();

    // The awaiting caller still gets its own pass's answer …
    await expect(stale).resolves.toMatchObject([{ loggedIn: true }]);
    await expect(forced).resolves.toMatchObject([{ loggedIn: false }]);
    // … but it never reached the cache or the renderer.
    await expect(service.list()).resolves.toMatchObject([{ loggedIn: false }]);
    for (const call of listener.mock.calls) {
      expect(call[0]).toMatchObject([{ loggedIn: false }]);
    }
  });
});
