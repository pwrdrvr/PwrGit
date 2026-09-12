import { describe, expect, it } from "vitest";
import { ForgeHostDirectory, type DiscoveredForgeHost } from "./cli-hosts";
import { ForgeHosts } from "./hosts";
import { resolveForge } from "./providers";

const GHE: DiscoveredForgeHost = {
  kind: "github",
  host: "github.acme-inc.com",
  account: "o.dev"
};

describe("ForgeHostDirectory", () => {
  it("answers empty before the first refresh instead of throwing", () => {
    // Boot does not block on two CLI spawns, so a resolve can land first.
    expect(new ForgeHostDirectory().current()).toEqual([]);
  });

  it("serves the cache after a refresh without spawning again", async () => {
    let calls = 0;
    const dir = new ForgeHostDirectory({
      discover: async () => {
        calls += 1;
        return [GHE];
      }
    });
    await dir.refresh();
    await dir.refresh();
    expect(calls).toBe(1);
    expect(dir.current()).toEqual([GHE]);
  });

  it("coalesces concurrent refreshes onto one pass", async () => {
    let calls = 0;
    const dir = new ForgeHostDirectory({
      discover: async () => {
        calls += 1;
        return [GHE];
      }
    });
    await Promise.all([dir.refresh(), dir.refresh(), dir.refresh()]);
    expect(calls).toBe(1);
  });

  it("keeps the previous list when a refresh fails", async () => {
    // A transient spawn failure must not make every Enterprise host stop
    // resolving for the rest of the session.
    let fail = false;
    const dir = new ForgeHostDirectory({
      discover: async () => {
        if (fail) throw new Error("spawn gh ENOENT");
        return [GHE];
      }
    });
    await dir.refresh();
    fail = true;
    await dir.refresh({ force: true });
    expect(dir.current()).toEqual([GHE]);
  });
});

describe("end to end: a GitHub Enterprise remote resolves", () => {
  const hostsFor = (discovered: DiscoveredForgeHost[]) =>
    new ForgeHosts({
      readSettings: () => ({ hosts: {} }),
      discovered: () => discovered,
      env: {}
    });

  it("does not resolve before the host is known", () => {
    // This is the state the branch shipped in until the resolvers were wired:
    // the token and baseUrl existed and nothing ever reached them.
    const hosts = hostsFor([]);
    expect(
      resolveForge("git@github.acme-inc.com:acme/app.git", hosts.overrides())
    ).toBeNull();
  });

  it("resolves to the GitHub provider once gh reports the host", () => {
    const hosts = hostsFor([GHE]);
    const resolved = resolveForge(
      "git@github.acme-inc.com:acme/app.git",
      hosts.overrides()
    );
    expect(resolved?.provider.kind).toBe("github");
    expect(resolved?.repo.host).toBe("github.acme-inc.com");
    expect(resolved?.repo.path).toBe("acme/app");
  });

  it("resolves several hosts of both forges at once", () => {
    const hosts = hostsFor([
      GHE,
      { kind: "github", host: "github.com" },
      { kind: "gitlab", host: "gitlab.com" },
      { kind: "gitlab", host: "git.contoso.dev" }
    ]);
    const cases: Array<[string, string, string]> = [
      ["git@github.com:o/r.git", "github", "github.com"],
      ["git@github.acme-inc.com:acme/app.git", "github", "github.acme-inc.com"],
      ["git@gitlab.com:g/sub/p.git", "gitlab", "gitlab.com"],
      ["https://git.contoso.dev/team/sub/p.git", "gitlab", "git.contoso.dev"]
    ];
    for (const [url, kind, host] of cases) {
      const resolved = resolveForge(url, hosts.overrides());
      expect(resolved?.provider.kind, url).toBe(kind);
      expect(resolved?.repo.host, url).toBe(host);
    }
  });

  it("still ignores an ssh remote that is not a forge", () => {
    const hosts = hostsFor([GHE]);
    expect(resolveForge("git@nas.local:/srv/git/thing.git", hosts.overrides()))
      .toBeNull();
  });
});
