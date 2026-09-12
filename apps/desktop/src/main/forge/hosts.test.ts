import { describe, expect, it } from "vitest";
import { parseForgeRemote, type ForgeSettings } from "@pwrgit/shared";
import type { DiscoveredForgeHost } from "./cli-hosts";
import { ForgeHosts } from "./hosts";

function make(opts: {
  hosts?: ForgeSettings["hosts"];
  discovered?: DiscoveredForgeHost[];
  env?: NodeJS.ProcessEnv;
}): ForgeHosts {
  return new ForgeHosts({
    readSettings: () => ({ hosts: opts.hosts ?? {} }),
    discovered: () => opts.discovered ?? [],
    env: opts.env ?? {}
  });
}

const GH = (host: string, account = "octo-dev"): DiscoveredForgeHost => ({
  kind: "github",
  host,
  account
});
const GL = (host: string, account = "o.dev"): DiscoveredForgeHost => ({
  kind: "gitlab",
  host,
  account
});

describe("ForgeHosts.kindFor", () => {
  it("knows the two SaaS hosts with no configuration at all", () => {
    const hosts = make({});
    expect(hosts.kindFor("github.com")).toEqual({
      kind: "github",
      source: "auto"
    });
    expect(hosts.kindFor("gitlab.com").kind).toBe("gitlab");
  });

  it("takes the kind from whichever CLI reported the host", () => {
    // Enumeration carries the product with it: `gh` only knows GitHub hosts.
    // Nothing is inferred from the name.
    const hosts = make({ discovered: [GH("github.acme-inc.com")] });
    expect(hosts.kindFor("github.acme-inc.com")).toEqual({
      kind: "github",
      source: "auto"
    });
  });

  it("does NOT guess from a gitlab.* hostname", () => {
    // A name is not evidence. This host is only a forge once glab is signed in
    // to it or the user adds it.
    expect(make({}).kindFor("gitlab.internal.example").kind).toBeNull();
  });

  it("stays silent about an ordinary ssh remote", () => {
    // The objection that reshaped this: a remote is an ssh target. A NAS or a
    // box on a home network is not a forge and must never become a row.
    for (const host of ["nas.local", "192.168.1.50", "build-box"]) {
      expect(make({}).kindFor(host).kind).toBeNull();
      expect(make({}).isEnabled(host).enabled).toBe(false);
    }
    expect(make({}).list()).toEqual([]);
  });

  it("lets the user name a host no CLI reports", () => {
    const hosts = make({ hosts: { "git.contoso.dev": { kind: "gitlab" } } });
    expect(hosts.kindFor("git.contoso.dev")).toEqual({
      kind: "gitlab",
      source: "config"
    });
  });

  it("lets config override what a CLI reported", () => {
    const hosts = make({
      hosts: { "gitlab.acme.com": { kind: "github" } },
      discovered: [GL("gitlab.acme.com")]
    });
    expect(hosts.kindFor("gitlab.acme.com").kind).toBe("github");
  });

  it("canonicalizes case and a www. prefix before matching config", () => {
    const hosts = make({ hosts: { "git.contoso.dev": { kind: "github" } } });
    expect(hosts.kindFor("WWW.Git.Contoso.Dev").kind).toBe("github");
  });

  it("prefers an env allowlist over config", () => {
    const hosts = make({
      hosts: { "git.contoso.dev": { kind: "gitlab" } },
      env: { PWRGIT_GITHUB_HOSTS: "git.contoso.dev" }
    });
    expect(hosts.kindFor("git.contoso.dev")).toEqual({
      kind: "github",
      source: "env"
    });
  });
});

describe("ForgeHosts.isEnabled", () => {
  it("derives on from being signed in to that host", () => {
    const hosts = make({ discovered: [GH("github.com")] });
    expect(hosts.isEnabled("github.com")).toEqual({
      enabled: true,
      source: "auto"
    });
  });

  it("stays on for a known forge nobody has signed in to", () => {
    // Enumeration decides which hosts get a ROW; it does not grant permission.
    // Deriving "on" from sign-in meant a machine with GITHUB_TOKEN and no gh
    // lost all change-request status, silently.
    const hosts = make({ discovered: [] });
    expect(hosts.isEnabled("github.com")).toEqual({
      enabled: true,
      source: "auto"
    });
    expect(hosts.isEnabled("gitlab.com").enabled).toBe(true);
  });

  it("stays on before enumeration has landed", () => {
    // The window between boot and the background refresh resolving. Gating on
    // discovery here made every PR refresh in that window a silent no-op.
    const hosts = make({ discovered: [] });
    expect(hosts.isEnabled("github.com").enabled).toBe(true);
  });

  it("keeps an explicit off after a later sign-in", () => {
    const hosts = make({
      hosts: { "gitlab.com": { enabled: false } },
      discovered: [GL("gitlab.com")]
    });
    expect(hosts.isEnabled("gitlab.com")).toEqual({
      enabled: false,
      source: "config"
    });
  });

  it("honours an explicit on before any sign-in", () => {
    const hosts = make({ hosts: { "gitlab.com": { enabled: true } } });
    expect(hosts.isEnabled("gitlab.com")).toEqual({
      enabled: true,
      source: "config"
    });
  });

  it("treats a set env allowlist as exhaustive, overriding config", () => {
    const hosts = make({
      hosts: { "gitlab.com": { enabled: true } },
      discovered: [GL("gitlab.com")],
      env: { PWRGIT_GITLAB_HOSTS: "gitlab.internal.example" }
    });
    expect(hosts.isEnabled("gitlab.com")).toEqual({
      enabled: false,
      source: "env"
    });
    expect(hosts.isEnabled("gitlab.internal.example").enabled).toBe(true);
  });

  it("reports an unknown host as not enabled", () => {
    // A switch flipped on a host that names no forge enables no transport.
    const hosts = make({ hosts: { "nas.local": { enabled: true } } });
    expect(hosts.isEnabled("nas.local").enabled).toBe(false);
  });
});

describe("ForgeHosts.isEnabled is the only gate on talking to a host", () => {
  it("answers for every caller, not just change-request status", () => {
    // `PrService`, the commit-author service and the background identity
    // refresh all gate on this one answer. `IdentityService` used to reach its
    // provider registry directly, so a host switched off here still produced
    // `gh api` / `glab api` subprocesses on profile load and after every
    // fetch — an "off" that shells out is a setting that lies.
    const hosts = make({
      hosts: { "github.com": { enabled: false } },
      discovered: [GH("github.com")]
    });
    expect(hosts.isEnabled("github.com").enabled).toBe(false);
    // However the caller spells it: `parseForgeRemote` lowercases, but a
    // hand-written config key or an env entry need not have.
    expect(hosts.isEnabled("GitHub.com").enabled).toBe(false);
    // Resolution is untouched — a disabled host still resolves to its kind,
    // so callers can tell "off" from "not a forge we know".
    expect(hosts.overrides()["github.com"]).toBe("github");
  });

  it("is off for a gitlab.* host the shared remote parser calls GitLab", () => {
    // The two classifiers disagree by design: `parseForgeRemote` still applies
    // the `gitlab.*` prefix rule, `ForgeHosts` refuses to guess a forge from a
    // name. Callers follow ForgeHosts, so this instance gets no settings row
    // AND no subprocess — including from the identity refresh, which reads the
    // remote through the prefix-rule parser.
    expect(
      parseForgeRemote("git@gitlab.internal.example:group/app.git")?.host
    ).toBe("gitlab");
    expect(make({}).isEnabled("gitlab.internal.example").enabled).toBe(false);
  });

  it("turns back on without reconstruction once the setting changes", () => {
    // The gate is a function read per lookup, not a value captured at
    // construction: flipping the switch must take effect on the next refresh
    // rather than at the next app start.
    let hosts: ForgeSettings["hosts"] = { "github.com": { enabled: false } };
    const service = new ForgeHosts({
      readSettings: () => ({ hosts }),
      discovered: () => [],
      env: {}
    });
    expect(service.isEnabled("github.com").enabled).toBe(false);
    hosts = { "github.com": { enabled: true } };
    expect(service.isEnabled("github.com").enabled).toBe(true);
  });
});

describe("ForgeHosts.overrides", () => {
  it("carries discovered hosts and explicit decisions, nothing else", () => {
    const hosts = make({
      hosts: {
        "git.contoso.dev": { kind: "gitlab" },
        "gitlab.com": { enabled: false }
      },
      discovered: [GH("github.acme-inc.com")]
    });
    expect(hosts.overrides()).toEqual({
      "github.acme-inc.com": "github",
      "git.contoso.dev": "gitlab"
    });
  });

  it("still names a host whose kind is known but which is disabled", () => {
    // Resolution and permission are different questions: dropping a disabled
    // host here would make "off" arrive at callers as "unknown forge".
    const hosts = make({
      hosts: { "git.contoso.dev": { kind: "gitlab", enabled: false } }
    });
    expect(hosts.overrides()["git.contoso.dev"]).toBe("gitlab");
    expect(hosts.isEnabled("git.contoso.dev").enabled).toBe(false);
  });

  it("resolves the same way kindFor does when env and config disagree", () => {
    // The map handed to resolveForgeRepo and the answer the pane paints must
    // agree, or one host routes to two different providers.
    const hosts = make({
      hosts: { "h.example": { kind: "gitlab" } },
      env: { PWRGIT_GITHUB_HOSTS: "h.example" }
    });
    expect(hosts.kindFor("h.example").kind).toBe("github");
    expect(hosts.overrides()["h.example"]).toBe("github");
  });

  it("lets config override a discovered host in both places", () => {
    const hosts = make({
      hosts: { "h.example": { kind: "github" } },
      discovered: [GL("h.example")]
    });
    expect(hosts.kindFor("h.example").kind).toBe("github");
    expect(hosts.overrides()["h.example"]).toBe("github");
  });

  it("includes env-named hosts", () => {
    const hosts = make({
      env: { PWRGIT_GITHUB_HOSTS: "ghe.acme.com, Other.Example " }
    });
    expect(hosts.overrides()).toEqual({
      "ghe.acme.com": "github",
      "other.example": "github"
    });
  });

  it("reflects a settings write without reconstruction", () => {
    // `readSettings` is a function precisely so a toggle takes effect on the
    // very next resolve rather than at the next app start.
    let hosts: ForgeSettings["hosts"] = {};
    const service = new ForgeHosts({
      readSettings: () => ({ hosts }),
      discovered: () => []
    });
    expect(service.kindFor("git.contoso.dev").kind).toBeNull();
    hosts = { "git.contoso.dev": { kind: "github" } };
    expect(service.kindFor("git.contoso.dev").kind).toBe("github");
  });
});

describe("ForgeHosts.list", () => {
  it("lists what the CLIs are signed in to, with their accounts", () => {
    const hosts = make({
      discovered: [GH("github.com", "octo-dev"), GL("gitlab.com", "o.dev")]
    });
    expect(hosts.list()).toEqual([
      {
        host: "github.com",
        kind: "github",
        kindSource: "auto",
        enabled: true,
        enabledSource: "auto",
        origin: "cli",
        account: "octo-dev"
      },
      {
        host: "gitlab.com",
        kind: "gitlab",
        kindSource: "auto",
        enabled: true,
        enabledSource: "auto",
        origin: "cli",
        account: "o.dev"
      }
    ]);
  });

  it("includes a user-added host no CLI reports, marked as such", () => {
    // This is the row that should offer a sign-in command: somebody said the
    // host is a GitLab, and glab holds no account for it.
    const hosts = make({
      hosts: { "git.contoso.dev": { kind: "gitlab" } }
    });
    const [entry] = hosts.list();
    expect(entry?.origin).toBe("config");
    expect(entry?.kind).toBe("gitlab");
    expect(entry?.enabled).toBe(true);
  });

  it("does not duplicate a host that is both added and signed in", () => {
    const hosts = make({
      hosts: { "github.acme-inc.com": { kind: "github" } },
      discovered: [GH("github.acme-inc.com")]
    });
    expect(hosts.list().map((entry) => entry.host)).toEqual([
      "github.acme-inc.com"
    ]);
    expect(hosts.list()[0]?.origin).toBe("cli");
  });

  it("shows no row for a config entry that only flipped a switch", () => {
    // `{enabled:false}` on an unknown host names no forge, so there is nothing
    // to render — and nothing to ask the user about.
    expect(make({ hosts: { "nas.local": { enabled: false } } }).list()).toEqual(
      []
    );
  });
});

describe("ForgeHosts.statusTargets", () => {
  it("always includes both SaaS hosts, so a working forge is never reported out", () => {
    // The regression this exists for: any config entry makes `list()` non-empty,
    // so a probe driven by `list()` alone never asked about github.com on a
    // machine whose only entry is a self-managed instance — and reported the
    // signed-in SaaS host as "Signed out" until something else forced a re-probe.
    const hosts = make({ hosts: { "gitlab.acme-inc.com": { kind: "gitlab" } } });

    expect(hosts.statusTargets()).toEqual([
      // `assumed`: nothing names these, so they are probed through the CLI's own
      // default host and kept out of the reported list.
      { kind: "github", host: "github.com", enabled: true, assumed: true },
      { kind: "gitlab", host: "gitlab.acme-inc.com", enabled: true },
      { kind: "gitlab", host: "gitlab.com", enabled: true, assumed: true }
    ]);
  });

  it("keys the backfill by kind as well as host", () => {
    // A row that resolves a SaaS hostname to the OTHER product must not suppress
    // that product's own target: matching on the hostname alone left GitLab with
    // no target at all, reported as signed out while `glab` was signed in.
    const hosts = make({ hosts: { "gitlab.com": { kind: "github" } } });

    expect(hosts.statusTargets()).toEqual([
      { kind: "github", host: "github.com", enabled: true, assumed: true },
      // The row, resolved to GitHub by the config entry …
      { kind: "github", host: "gitlab.com", enabled: true },
      // … and GitLab still gets a target of its own.
      { kind: "gitlab", host: "gitlab.com", enabled: true, assumed: true }
    ]);
  });

  it("names each SaaS host once when a CLI already reports it", () => {
    const hosts = make({ discovered: [GH("github.com"), GL("gitlab.com")] });

    expect(hosts.statusTargets().map((target) => target.host)).toEqual([
      "github.com",
      "gitlab.com"
    ]);
  });

  it("carries the switch, so a host the user turned off is never probed", () => {
    const hosts = make({
      discovered: [GL("gitlab.acme-inc.com")],
      hosts: { "gitlab.acme-inc.com": { enabled: false } }
    });

    expect(
      hosts.statusTargets().find((target) => target.host === "gitlab.acme-inc.com")
    ).toEqual({ kind: "gitlab", host: "gitlab.acme-inc.com", enabled: false });
  });

  it("respects an env allowlist that excludes the SaaS host", () => {
    // A set allowlist is exhaustive. The SaaS host is added because resolution
    // knows it, not because it is exempt from the switches.
    const hosts = make({
      discovered: [GH("github.acme-inc.com")],
      env: { PWRGIT_GITHUB_HOSTS: "github.acme-inc.com" }
    });

    expect(hosts.statusTargets()).toEqual([
      { kind: "github", host: "github.acme-inc.com", enabled: true },
      { kind: "github", host: "github.com", enabled: false, assumed: true },
      { kind: "gitlab", host: "gitlab.com", enabled: true, assumed: true }
    ]);
  });

  it("skips a host whose forge cannot be identified", () => {
    // A bare ssh remote earns no row and no probe — there is no transport to
    // ask, and asking would mean guessing which product runs there.
    const hosts = make({ hosts: { "nas.local": { enabled: true } } });

    expect(hosts.statusTargets().map((target) => target.host)).toEqual([
      "github.com",
      "gitlab.com"
    ]);
  });
});

describe("ForgeHosts canonicalization", () => {
  it("matches a stored key however the caller spells the host", () => {
    const hosts = make({ hosts: { "git.example": { kind: "gitlab" } } });
    for (const spelling of ["git.example", "GIT.EXAMPLE", "www.git.example", " Git.Example "]) {
      expect(hosts.kindFor(spelling).kind).toBe("gitlab");
    }
  });

  it("matches nothing for a key that is not a bare hostname", () => {
    // The write path refuses these, so nothing should ever be stored under
    // one — but a hand-edited settings file must not resolve either.
    const hosts = make({ hosts: { "ghe.example:8443": { kind: "github" } } });
    expect(hosts.kindFor("ghe.example").kind).toBeNull();
    expect(hosts.list()).toEqual([]);
  });
});
