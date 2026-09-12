import { describe, expect, it, vi } from "vitest";
import { targetHost } from "./cli-runner";
import { GitHubRepoProvider } from "./github/repo-provider";
import { GitLabRepoProvider } from "./gitlab/repo-provider";

describe("targetHost", () => {
  it("puts --hostname on an api call, after the verb", () => {
    expect(
      targetHost({
        hostname: "ghe.acme.com",
        defaultHost: "github.com",
        hostEnvName: "GH_HOST",
        args: ["api", "user"]
      })
    ).toEqual({ args: ["api", "--hostname", "ghe.acme.com", "user"], env: {} });
  });

  it("uses the host env var for anything that is NOT an api call", () => {
    // `gh repo fork` and `gh search repos` reject --hostname outright, and
    // splicing it after argv[0] also lands it before the subcommand.
    expect(
      targetHost({
        hostname: "ghe.acme.com",
        defaultHost: "github.com",
        hostEnvName: "GH_HOST",
        args: ["repo", "fork", "acme/app"]
      })
    ).toEqual({
      args: ["repo", "fork", "acme/app"],
      env: { GH_HOST: "ghe.acme.com" }
    });
  });

  it("leaves the default host's argv and env completely alone", () => {
    // So an operator's own GH_HOST still decides on github.com.
    expect(
      targetHost({
        hostname: "github.com",
        defaultHost: "github.com",
        hostEnvName: "GH_HOST",
        args: ["repo", "fork", "acme/app"]
      })
    ).toEqual({ args: ["repo", "fork", "acme/app"], env: {} });
  });

  it("keeps caller env alongside the host var", () => {
    expect(
      targetHost({
        hostname: "gitlab.internal.example",
        defaultHost: "gitlab.com",
        hostEnvName: "GITLAB_HOST",
        args: ["repo", "clone", "g/p"],
        env: { GIT_TERMINAL_PROMPT: "0" }
      }).env
    ).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GITLAB_HOST: "gitlab.internal.example"
    });
  });
});

const FORK = {
  source: "a/b",
  targetOwner: "o",
  targetOwnerKind: "user" as const,
  targetName: "b",
  defaultBranchOnly: false
};

describe("every provider call reaches the right instance", () => {
  const capture = () => {
    const calls: Array<{ args: string[]; env?: unknown }> = [];
    const run = vi.fn(async (args: string[], opts?: { env?: unknown }) => {
      calls.push({ args, ...(opts?.env === undefined ? {} : { env: opts.env }) });
      return JSON.stringify({ login: "o", username: "o", id: 1, path_with_namespace: "a/b" });
    });
    return { run, calls };
  };

  it("never sends --hostname to a gh command that rejects it", async () => {
    const { run, calls } = capture();
    const gh = new GitHubRepoProvider(run, "ghe.acme.com");
    await gh.owners().catch(() => undefined);
    await gh.searchRepos({ query: "x", owners: [], limit: 10 }).catch(() => undefined);
    await gh.fork(FORK).catch(() => undefined);
    for (const call of calls) {
      const flagAt = call.args.indexOf("--hostname");
      if (flagAt !== -1) {
        // Only `gh api` accepts it, and only straight after the verb.
        expect(call.args[0], call.args.join(" ")).toBe("api");
        expect(flagAt, call.args.join(" ")).toBe(1);
      } else {
        expect(call.env, call.args.join(" ")).toMatchObject({
          GH_HOST: "ghe.acme.com"
        });
      }
    }
    expect(calls.length).toBeGreaterThan(0);
  });

  it("targets every glab call, including the fork POST", async () => {
    const { run, calls } = capture();
    const glab = new GitLabRepoProvider(run, "gitlab.internal.example");
    await glab.owners().catch(() => undefined);
    await glab.fork({ ...FORK, source: "g/p", targetName: "p" }).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const targeted =
        call.args.includes("--hostname") ||
        (call.env as Record<string, string> | undefined)?.["GITLAB_HOST"] ===
          "gitlab.internal.example";
      expect(targeted, `untargeted: glab ${call.args.join(" ")}`).toBe(true);
    }
  });

  it("leaves a default-host call byte-identical, options included", async () => {
    const { run, calls } = capture();
    await new GitHubRepoProvider(run).owners().catch(() => undefined);
    expect(calls[0]?.args).toEqual(["api", "user"]);
    expect(calls[0]?.env).toBeUndefined();
    expect(run.mock.calls[0]).toHaveLength(1);
  });
});
