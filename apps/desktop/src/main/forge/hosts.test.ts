import { describe, expect, it } from "vitest";
import type { ForgeSettings } from "@pwrgit/shared";
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

  it("derives off when that CLI holds no account for the host", () => {
    // The GitHub-only machine: nothing is broken, so nothing should be probed.
    const hosts = make({ discovered: [GH("github.com")] });
    expect(hosts.isEnabled("gitlab.com")).toEqual({
      enabled: false,
      source: "auto"
    });
  });

  it("derives per host, not per forge", () => {
    const hosts = make({ discovered: [GH("github.com")] });
    expect(hosts.isEnabled("github.acme-inc.com").enabled).toBe(false);
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
    expect(entry?.enabled).toBe(false);
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
