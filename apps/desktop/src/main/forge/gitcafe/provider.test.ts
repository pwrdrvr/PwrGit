import type { CafeRunner } from "./cafe-cli";
import { describe, expect, it, vi } from "vitest";
import { connectForge, type ForgeRepo } from "../types";
import { createGitCafeProvider, parseCafePr } from "./provider";

const repo: ForgeRepo = {
  kind: "gitcafe",
  host: "git.cafe",
  path: "sample/demo"
};
const pr = (number = 1, extra = {}) => ({
  number,
  title: "Contrived PR",
  state: "open",
  draft: false,
  crossFork: false,
  sourceBranch: "feature",
  targetBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  ...extra
});
const envelope = (data: unknown) => JSON.stringify({ schemaVersion: 1, data });
const page = (items: unknown[], nextCursor: string | null = null) =>
  envelope({ items, page: { nextCursor, truncated: nextCursor !== null } });

describe("GitCafe pull requests", () => {
  it("connects without extracting or inventing a token", async () => {
    const run = vi.fn<CafeRunner>(async () => page([pr()]));
    const provider = createGitCafeProvider(run);
    const connection = await connectForge(provider, repo.host);
    expect(connection).toBe(provider);
    expect(run).not.toHaveBeenCalled();
    expect(
      await connection!.fetchPrsForBranches(repo, ["feature"])
    ).toMatchObject(new Map([["feature", { number: 1, forge: "gitcafe" }]]));
    expect(run.mock.calls[0]?.[0]).not.toContain("auth");
  });
  it("walks all pages before selecting the newest PR and negative caching", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(page([pr(1)], "second"))
      .mockResolvedValueOnce(page([pr(3, { state: "merged" })]));
    const result = await createGitCafeProvider(run).fetchPrsForBranches(repo, [
      "feature",
      "missing"
    ]);
    expect(result.get("feature")).toMatchObject({
      number: 3,
      state: "merged",
      url: "https://git.cafe/sample/demo/pulls/3"
    });
    expect(result.get("missing")).toBeNull();
    expect(run.mock.calls[1]?.[0]).toEqual([
      "pr",
      "list",
      "--repo",
      "sample/demo",
      "--limit",
      "200",
      "--json",
      "--host",
      "https://git.cafe/api",
      "--cursor",
      "second"
    ]);
  });
  it("never negative caches a failed or looping page", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(page([pr()], "second"))
      .mockRejectedValueOnce(new Error("429"));
    await expect(
      createGitCafeProvider(run).fetchPrsForBranches(repo, ["missing"])
    ).rejects.toThrow("429");
    await expect(
      createGitCafeProvider(async () => page([], "again")).fetchPrsForBranches(
        repo,
        ["missing"]
      )
    ).rejects.toThrow("repeated");
  });
  it("does not associate another fork's same-named branch", async () => {
    const run = async () =>
      page([pr(1, { sourceRepo: { owner: "someone", name: "demo" } })]);
    expect(
      (
        await createGitCafeProvider(run).fetchPrsForBranches(repo, ["feature"])
      ).get("feature")
    ).toBeNull();
  });
  it("refreshes known PRs and keeps completed requests before a failure", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(envelope({ resource: pr(1, { state: "closed" }) }))
      .mockRejectedValueOnce(new Error("network"));
    const result = await createGitCafeProvider(run).fetchPrsByNumbers(
      repo,
      [1, 2, 3]
    );
    expect(result.get(1)?.state).toBe("closed");
    expect(result.has(2)).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("does not turn unsupported commit association into a negative answer", async () => {
    const run = vi.fn();
    expect(
      await createGitCafeProvider(run).fetchPrsForCommits(repo, [
        "a".repeat(40)
      ])
    ).toEqual(new Map());
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects malformed PRs and preserves draft/timestamps", () => {
    expect(() => parseCafePr({}, repo)).toThrow("invalid pull request");
    expect(parseCafePr(pr(2, { draft: true }), repo)).toMatchObject({
      isDraft: true,
      createdAt: Date.parse("2026-09-01T00:00:00Z")
    });
  });
});

it("checks details when a list omits provenance and skips a cross-fork PR", async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce(
      page([pr(1, { crossFork: undefined }), pr(2, { crossFork: undefined })])
    )
    .mockResolvedValueOnce(
      envelope({
        resource: pr(2, {
          crossFork: true,
          headRepo: { owner: "elsewhere", name: "demo" }
        })
      })
    )
    .mockResolvedValueOnce(envelope({ resource: pr(1, { crossFork: false }) }));
  const result = await createGitCafeProvider(run).fetchPrsForBranches(repo, [
    "feature"
  ]);
  expect(result.get("feature")?.number).toBe(1);
  expect(run.mock.calls[1]?.[0]).toContain("2");
  expect(run.mock.calls[2]?.[0]).toContain("1");
});

it("does not negative-cache a branch when provenance cannot be read", async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce(page([pr(1, { crossFork: undefined })]))
    .mockRejectedValueOnce(new Error("network"));
  await expect(
    createGitCafeProvider(run).fetchPrsForBranches(repo, ["feature"])
  ).rejects.toThrow("network");
});
