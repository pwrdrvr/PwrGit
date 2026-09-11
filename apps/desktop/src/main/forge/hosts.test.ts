import { describe, expect, it } from "vitest";
import type { ForgeKind, ForgeSettings } from "@pwrgit/shared";
import { ForgeHosts } from "./hosts";

function make(opts: {
  hosts?: ForgeSettings["hosts"];
  signedIn?: Array<`${ForgeKind}:${string}`>;
  env?: NodeJS.ProcessEnv;
}): ForgeHosts {
  const signedIn = new Set(opts.signedIn ?? []);
  return new ForgeHosts({
    readSettings: () => ({ hosts: opts.hosts ?? {} }),
    isSignedIn: (kind, host) => signedIn.has(`${kind}:${host}`),
    env: opts.env ?? {}
  });
}

describe("ForgeHosts.kindFor", () => {
  it("classifies the two SaaS hosts and the gitlab.* convention", () => {
    const hosts = make({});
    expect(hosts.kindFor("github.com")).toEqual({
      kind: "github",
      source: "auto"
    });
    expect(hosts.kindFor("gitlab.com").kind).toBe("gitlab");
    expect(hosts.kindFor("gitlab.internal.example").kind).toBe("gitlab");
  });

  it("returns null for a host nothing can identify", () => {
    // The whole point of the settings row: guessing here would send a private
    // repo's metadata at the wrong forge's API.
    expect(make({}).kindFor("git.contoso.dev")).toEqual({
      kind: null,
      source: "auto"
    });
  });

  it("lets an explicit choice name a host the heuristic cannot", () => {
    const hosts = make({ hosts: { "git.contoso.dev": { kind: "gitlab" } } });
    expect(hosts.kindFor("git.contoso.dev")).toEqual({
      kind: "gitlab",
      source: "config"
    });
  });

  it("lets an explicit choice override the heuristic outright", () => {
    // `gitlab.acme.com` running GitHub Enterprise is perverse but legal, and
    // the operator is better informed than the prefix rule.
    const hosts = make({ hosts: { "gitlab.acme.com": { kind: "github" } } });
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
    const hosts = make({ signedIn: ["github:github.com"] });
    expect(hosts.isEnabled("github.com")).toEqual({
      enabled: true,
      source: "auto"
    });
  });

  it("derives off when that CLI holds no account for the host", () => {
    // The GitHub-only machine: nothing is broken, so nothing should be probed.
    const hosts = make({ signedIn: ["github:github.com"] });
    expect(hosts.isEnabled("gitlab.com")).toEqual({
      enabled: false,
      source: "auto"
    });
  });

  it("derives per host, not per forge", () => {
    const hosts = make({ signedIn: ["github:github.com"] });
    expect(hosts.isEnabled("github.acme-inc.com").enabled).toBe(false);
  });

  it("keeps an explicit off after a later sign-in", () => {
    const hosts = make({
      hosts: { "gitlab.com": { enabled: false } },
      signedIn: ["gitlab:gitlab.com"]
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
      signedIn: ["gitlab:gitlab.com"],
      env: { PWRGIT_GITLAB_HOSTS: "gitlab.internal.example" }
    });
    expect(hosts.isEnabled("gitlab.com")).toEqual({
      enabled: false,
      source: "env"
    });
    expect(hosts.isEnabled("gitlab.internal.example").enabled).toBe(true);
  });

  it("reports an unclassified host as not enabled", () => {
    // There is no transport to turn on until somebody says which forge it is.
    const hosts = make({ hosts: { "git.contoso.dev": { enabled: true } } });
    expect(hosts.isEnabled("git.contoso.dev").enabled).toBe(false);
  });
});

describe("ForgeHosts.overrides", () => {
  it("carries only explicit decisions, not the heuristic's answers", () => {
    const hosts = make({
      hosts: {
        "git.contoso.dev": { kind: "gitlab" },
        "gitlab.com": { enabled: false }
      }
    });
    expect(hosts.overrides()).toEqual({ "git.contoso.dev": "gitlab" });
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
      isSignedIn: () => false
    });
    expect(service.kindFor("git.contoso.dev").kind).toBeNull();
    hosts = { "git.contoso.dev": { kind: "github" } };
    expect(service.kindFor("git.contoso.dev").kind).toBe("github");
  });
});
