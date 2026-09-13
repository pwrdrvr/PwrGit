import type { CafeRunner } from "./cafe-cli";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitCafeRepoProvider, parseCafeRepo } from "./repo-provider";
const resource = (name = "demo", extra = {}) => ({
  owner: "sample",
  name,
  visibility: "private",
  parent: null,
  ...extra
});
const data = (value: unknown) =>
  JSON.stringify({ schemaVersion: 1, data: value });
const wrapped = (value: unknown) => data({ resource: value });
const page = (items: unknown[]) =>
  data({ items, page: { nextCursor: null, truncated: false } });
afterEach(() => vi.useRealTimers());

describe("GitCafe repositories", () => {
  it("preserves visibility and parent lineage", () => {
    expect(
      parseCafeRepo(
        resource("fork", { parent: { owner: "upstream", name: "demo" } }),
        "cafe.example"
      )
    ).toMatchObject({
      host: "gitcafe",
      hostname: "cafe.example",
      visibility: "private",
      nameWithOwner: "sample/fork",
      parent: {
        nameWithOwner: "upstream/demo",
        url: "https://cafe.example/upstream/demo"
      }
    });
    expect(() => parseCafeRepo({ parent: null }, "git.cafe")).toThrow();
    expect(() =>
      parseCafeRepo(resource("demo", { visibility: undefined }), "git.cafe")
    ).toThrow("visibility");
  });
  it("targets the selected host and rejects mismatched repository responses", async () => {
    const run = vi.fn<CafeRunner>(async () => wrapped(resource()));
    const provider = new GitCafeRepoProvider(run, "cafe.example");
    expect((await provider.viewRepo("sample/demo")).hostname).toBe(
      "cafe.example"
    );
    expect(run.mock.calls[0]?.[0]).toEqual([
      "repo",
      "view",
      "sample/demo",
      "--json",
      "--host",
      "https://cafe.example/api"
    ]);
    await expect(provider.viewRepo("sample/other")).rejects.toThrow(
      "different repository"
    );
  });
  it("lists personal and organization fork targets", async () => {
    const provider = new GitCafeRepoProvider(async () =>
      page([
        { handle: "sample", personal: true },
        { handle: "team", personal: false }
      ])
    );
    expect(await provider.owners()).toEqual([
      { host: "gitcafe", login: "sample", kind: "user" },
      { host: "gitcafe", login: "team", kind: "organization" }
    ]);
  });
  it("searches only on input, in one bounded call for multiple owners", async () => {
    const run = vi.fn<CafeRunner>(async () =>
      page([
        resource(),
        resource("unrelated"),
        resource("demo", { owner: "elsewhere" })
      ])
    );
    const provider = new GitCafeRepoProvider(run);
    expect(
      await provider.searchRepos({ query: "", owners: [], limit: 20 })
    ).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(
      (
        await provider.searchRepos({
          query: "demo",
          owners: ["sample", "team"],
          limit: 20
        })
      ).map((repo) => repo.nameWithOwner)
    ).toEqual(["sample/demo"]);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("forks into the chosen owner, waits for visibility, and passes cancellation", async () => {
    vi.useFakeTimers();
    const run = vi
      .fn()
      .mockResolvedValueOnce(wrapped({ name: "demo", state: "pending" }))
      .mockRejectedValueOnce(new Error("NOT_FOUND (HTTP 404)"))
      .mockResolvedValueOnce(wrapped(resource()));
    const onPhase = vi.fn();
    const controller = new AbortController();
    const pending = new GitCafeRepoProvider(run).fork({
      source: "upstream/demo",
      targetOwner: "sample",
      targetOwnerKind: "user",
      targetName: "demo",
      defaultBranchOnly: false,
      onPhase,
      signal: controller.signal
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).nameWithOwner).toBe("sample/demo");
    expect(run.mock.calls[0]).toEqual([
      [
        "repo",
        "fork",
        "upstream/demo",
        "--org",
        "sample",
        "--name",
        "demo",
        "--json",
        "--host",
        "https://git.cafe/api"
      ],
      expect.objectContaining({ signal: controller.signal })
    ]);
    expect(onPhase.mock.calls).toEqual([["creating"], ["awaiting_fork"]]);
  });
  it("rejects blocked forks and already canceled requests", async () => {
    const run = vi.fn<CafeRunner>(async () =>
      wrapped({ name: "demo", state: "blocked" })
    );
    const input = {
      source: "upstream/demo",
      targetOwner: "sample",
      targetOwnerKind: "organization" as const,
      targetName: "demo",
      defaultBranchOnly: false
    };
    await expect(new GitCafeRepoProvider(run).fork(input)).rejects.toThrow(
      "blocked"
    );
    run.mockClear();
    await expect(
      new GitCafeRepoProvider(run).fork({
        ...input,
        signal: AbortSignal.abort()
      })
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it("clones through cafe with streaming and abort options", async () => {
    const run = vi.fn<CafeRunner>(async () => "{}");
    const options = {
      onStderr: vi.fn(),
      env: { GIT_TERMINAL_PROMPT: "0" },
      signal: new AbortController().signal
    };
    await new GitCafeRepoProvider(run, "cafe.example").cloneWithCli(
      "sample/demo",
      "/tmp/destination with spaces",
      options
    );
    expect(run).toHaveBeenCalledWith(
      [
        "repo",
        "clone",
        "sample/demo",
        "/tmp/destination with spaces",
        "--json",
        "--host",
        "https://cafe.example/api"
      ],
      expect.objectContaining(options)
    );
  });
});
