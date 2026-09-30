import { describe, expect, it, vi } from "vitest";
import guard from "./github-network-guard.cjs";

describe("GitHub test network guard", () => {
  it.each([
    "https://api.github.com/repos/pwrdrvr/PwrGit/releases?per_page=30",
    "https://API.GITHUB.COM./repos/pwrdrvr/PwrGit/releases",
    new URL("https://github.com/pwrdrvr/PwrGit/releases/download/v1/latest.yml"),
    new Request("https://api.github.com/repos/pwrdrvr/PwrGit/releases"),
    { hostname: "api.github.com", path: "/repos/pwrdrvr/PwrGit/releases" },
    { host: "api.github.com:443", path: "/repos/pwrdrvr/PwrGit/releases" },
    { url: "https://objects.githubusercontent.com/update.zip" }
  ])("blocks before invoking any transport: %s", input => {
    const transport = vi.fn();
    const target = { request: transport };
    const installed = guard.installGitHubNetworkGuard([[target, "request"]]);
    expect(() => target.request(input)).toThrow("Unstubbed GitHub request");
    expect(transport).not.toHaveBeenCalled();
    // A caller catching the exception cannot hide it from suite teardown.
    expect(installed.attempts).toHaveLength(1);
    installed.restore();
    expect(target.request).toBe(transport);
  });

  it("allows local servers and explicit stubs, but guards forwarding spies", () => {
    const transport = vi.fn(() => "local response");
    const target = { fetch: transport };
    const installed = guard.installGitHubNetworkGuard([[target, "fetch"]]);
    expect(target.fetch("http://127.0.0.1:1234/token")).toBe("local response");
    const guarded = target.fetch;
    target.fetch = vi.fn(() => "stub release");
    expect(target.fetch("https://api.github.com/releases")).toBe("stub release");
    expect(installed.attempts).toEqual([]);
    target.fetch = (...args) => guarded(...args);
    expect(() => target.fetch("https://api.github.com/releases")).toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
