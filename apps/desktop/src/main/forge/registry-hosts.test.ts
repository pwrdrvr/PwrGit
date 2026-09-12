import { describe, expect, it, vi } from "vitest";
import { ForgeRepoRegistry } from "./repo-provider";
import { GitHubRepoProvider } from "./github/repo-provider";
import { GitLabRepoProvider } from "./gitlab/repo-provider";

function registry() {
  const calls: string[][] = [];
  const run = vi.fn(async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ login: "o.dev" });
  });
  const reg = new ForgeRepoRegistry();
  reg.register(
    new GitHubRepoProvider(run),
    (hostname) => new GitHubRepoProvider(run, hostname)
  );
  reg.register(
    new GitLabRepoProvider(run),
    (hostname) => new GitLabRepoProvider(run, hostname)
  );
  return { reg, calls };
}

describe("ForgeRepoRegistry keyed by host", () => {
  it("still answers the SaaS host when only a kind is given", () => {
    const { reg } = registry();
    expect(reg.get("github")?.hostname).toBe("github.com");
    expect(reg.get("gitlab")?.hostname).toBe("gitlab.com");
  });

  it("builds a provider for an Enterprise host on demand", () => {
    const { reg } = registry();
    expect(reg.get("github", "github.acme-inc.com")?.hostname).toBe(
      "github.acme-inc.com"
    );
  });

  it("canonicalizes the hostname before keying or building", () => {
    // The hostname now arrives from the renderer over IPC. Keying on the raw
    // string let one server become two providers, and — worse — sent
    // `www.github.com` past the pre-seeded SaaS entry into a `gh api
    // --hostname www.github.com` that cannot succeed.
    const { reg } = registry();
    expect(reg.get("github", "www.github.com")).toBe(reg.get("github"));
    expect(reg.get("gitlab", " GitLab.com ")).toBe(reg.get("gitlab"));
    expect(reg.get("github", "GHE.Acme.Example")).toBe(
      reg.get("github", "ghe.acme.example")
    );
    expect(reg.get("github", "GHE.Acme.Example")?.hostname).toBe(
      "ghe.acme.example"
    );
    // Anything that is not a bare hostname is refused outright, so a renderer
    // string can never reach a subprocess argument as an option or a URL.
    for (const bogus of [
      "ghe.acme.example/../evil",
      "ghe.acme.example:8443",
      "--version",
      "a host",
      "https://ghe.acme.example"
    ]) {
      expect(reg.get("github", bogus)).toBeNull();
    }
  });

  it("caches the built provider rather than rebuilding per call", () => {
    const { reg } = registry();
    expect(reg.get("github", "ghe.acme.com")).toBe(
      reg.get("github", "ghe.acme.com")
    );
  });

  it("sends --hostname to gh for an Enterprise host, and not for github.com", async () => {
    const { reg, calls } = registry();
    await reg.get("github", "github.acme-inc.com")?.owners();
    expect(calls[0]).toEqual([
      "api",
      "--hostname",
      "github.acme-inc.com",
      "user"
    ]);
    calls.length = 0;
    await reg.get("github")?.owners();
    expect(calls[0]).toEqual(["api", "user"]);
  });

  it("sends --hostname to glab for a self-managed instance", async () => {
    const { reg, calls } = registry();
    await reg.get("gitlab", "gitlab.internal.example")?.owners();
    expect(calls[0]).toEqual([
      "api",
      "--hostname",
      "gitlab.internal.example",
      "user"
    ]);
  });
});
