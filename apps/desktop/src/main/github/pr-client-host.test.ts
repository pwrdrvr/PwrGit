import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubTokenCache,
  githubGraphqlBaseUrl
} from "./pr-client";

vi.mock("./gh-cli", () => ({
  runGh: vi.fn(async (args: string[]) => `token-for-${args.at(-1)}`)
}));

afterEach(() => {
  clearGitHubTokenCache();
  delete process.env["GITHUB_TOKEN"];
  vi.clearAllMocks();
});

describe("githubGraphqlBaseUrl", () => {
  it("leaves github.com to Octokit's own default", () => {
    expect(githubGraphqlBaseUrl({ host: "github.com" })).toBeUndefined();
  });

  it("points Enterprise Server at its own /api", () => {
    expect(githubGraphqlBaseUrl({ host: "github.acme-inc.com" })).toBe(
      "https://github.acme-inc.com/api"
    );
  });

  it("keeps a non-default web port", () => {
    // Dropping it would send the Enterprise token at whatever answers on 443.
    expect(githubGraphqlBaseUrl({ host: "ghe.acme.com", port: 8443 })).toBe(
      "https://ghe.acme.com:8443/api"
    );
  });

  it("normalizes case", () => {
    expect(githubGraphqlBaseUrl({ host: "GHE.Acme.COM" })).toBe(
      "https://ghe.acme.com/api"
    );
  });
});

describe("getGitHubToken", () => {
  it("uses GITHUB_TOKEN for github.com", async () => {
    process.env["GITHUB_TOKEN"] = "env-token";
    const { getGitHubToken } = await import("./pr-client");
    expect(await getGitHubToken("github.com")).toBe("env-token");
  });

  it("does NOT send GITHUB_TOKEN to an Enterprise host", async () => {
    // A github.com PAT must never reach a self-managed server; that host falls
    // through to `gh auth token --hostname` instead.
    process.env["GITHUB_TOKEN"] = "env-token";
    const { getGitHubToken } = await import("./pr-client");
    const token = await getGitHubToken("github.acme-inc.com");
    expect(token).not.toBe("env-token");
    expect(token).toBe("token-for-github.acme-inc.com");
  });

  it("caches per host rather than in one slot", async () => {
    const { getGitHubToken } = await import("./pr-client");
    expect(await getGitHubToken("github.com")).toBe("token-for-github.com");
    expect(await getGitHubToken("ghe.acme.com")).toBe("token-for-ghe.acme.com");
  });
});
