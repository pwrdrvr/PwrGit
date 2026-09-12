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
