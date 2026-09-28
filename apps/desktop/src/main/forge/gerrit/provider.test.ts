import { describe, expect, it, vi } from "vitest";
import { createGerritProvider, gerritChange } from "./provider";
import { connectForge, type ForgeRepo } from "../types";
import { GerritRepoProvider } from "./repo-provider";
import { gerritReviewUrl } from "@pwrgit/shared";

const sha = "a".repeat(40);
const chromium: ForgeRepo = { kind: "gerrit", host: "chromium.googlesource.com", path: "v8/v8" };
function change(number = 123, extra: Record<string, unknown> = {}) {
  return { _number: number, project: "v8/v8", subject: "Contrived change", status: "NEW", branch: "main", work_in_progress: false,
    created: "2026-09-01 12:00:00.000000000", updated: "2026-09-02 12:00:00.000000000",
    current_revision: sha, revisions: { [sha]: { _number: 2, ref: `refs/changes/${String(number % 100).padStart(2, "0")}/${number}/2` } }, ...extra };
}

describe("Gerrit public change provider", () => {
  it.each([
    [chromium, "https://chromium-review.googlesource.com/c/v8/v8/+/123"],
    [{ kind: "gerrit", host: "codereview.qt-project.org", path: "qt/qtbase" } as ForgeRepo, "https://codereview.qt-project.org/c/qt/qtbase/+/123"],
    [{ kind: "gerrit", host: "git.example", path: "project", reviewUrl: "https://review.example/r" } as ForgeRepo, "https://review.example/r/c/project/+/123"]
  ])("uses the review endpoint for %o", async (repo, url) => {
    const get = vi.fn(async () => [change(123, { project: repo.path })]);
    const provider = createGerritProvider(get);
    expect(await connectForge(provider, repo.host)).toBe(provider);
    const result = await provider.fetchOpenPrs(repo);
    expect(result.items[0]).toMatchObject({ url, forge: "gerrit", headRefName: "refs/changes/23/123/2", baseRefName: "main", createdAt: Date.UTC(2026, 8, 1, 12) });
    expect(get.mock.calls).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty("checkState");
    expect(result.items[0]).not.toHaveProperty("headRepoPath");
  });

  it("does not query Gerrit's target branch as a source-branch PR", async () => {
    const get = vi.fn();
    expect(await createGerritProvider(get).fetchPrsForBranches(chromium, ["main"])).toEqual(new Map());
    expect(get).not.toHaveBeenCalled();
  });

  it("walks pagination and refuses a repeated page or a later failure", async () => {
    const get = vi.fn().mockResolvedValueOnce([change(123, { _more_changes: true })]).mockResolvedValueOnce([change(124)]);
    const result = await createGerritProvider(get).fetchOpenPrs(chromium);
    expect(result.items.map((row) => row.number)).toEqual([123, 124]);
    expect(get.mock.calls[1]?.[1]).toContain("S=1");
    await expect(createGerritProvider(vi.fn(async () => [change(123, { _more_changes: true })])).fetchOpenPrs(chromium)).rejects.toThrow("inconsistent page");
    const fail = vi.fn().mockResolvedValueOnce([change(123, { _more_changes: true })]).mockRejectedValueOnce(new Error("offline"));
    await expect(createGerritProvider(fail).fetchOpenPrs(chromium)).rejects.toThrow("offline");
  });

  it("caps the open list and reports truncation", async () => {
    let n = 1;
    const get = vi.fn(async () => Array.from({ length: 100 }, (_, i) => change(n++, i === 99 ? { _more_changes: true } : {})));
    const result = await createGerritProvider(get).fetchOpenPrs(chromium);
    expect(result.items).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(get).toHaveBeenCalledTimes(5);
  });

  it.each([{}, { status: "UNKNOWN" }, { project: "another/project" }, { revisions: { [sha]: { ref: "refs/heads/main" } } }])("rejects invalid responses rather than caching no change: %o", async (extra) => {
    const data = Object.keys(extra).length === 0 ? {} : change(123, extra);
    await expect(createGerritProvider(async () => [data]).fetchOpenPrs(chromium)).rejects.toThrow();
  });

  it("maps merged and abandoned lifecycle without inferring CI or a close timestamp", () => {
    expect(gerritChange(change(123, { status: "ABANDONED" }), chromium)).toMatchObject({ state: "closed" });
    expect(gerritChange(change(123, { status: "MERGED" }), chromium)).toMatchObject({ state: "merged" });
    expect(gerritChange(change(123, { status: "ABANDONED" }), chromium)).not.toHaveProperty("closedAt");
  });

  it("rejects a different change number than requested", async () => {
    await expect(createGerritProvider(async () => [change(124)]).fetchPrsByNumbers(chromium, [123])).rejects.toThrow("different change");
  });

  it("distinguishes missing results from failure and keeps partial lookups", async () => {
    const get = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("offline"));
    const result = await createGerritProvider(get).fetchPrsByNumbers(chromium, [123, 124]);
    expect(result.has(123)).toBe(true);
    expect(result.get(123)).toBeNull();
    expect(result.has(124)).toBe(false);
    await expect(createGerritProvider(async () => { throw new Error("offline"); }).fetchPrsByNumbers(chromium, [123])).rejects.toThrow("offline");
  });
});

it("reads public project identity without inventing push permission, accounts or clone alternatives", async () => {
  const provider = new GerritRepoProvider("git.example", () => "https://review.example/r", async (repo, path) => {
    expect(gerritReviewUrl(repo.host, repo.reviewUrl)).toBe("https://review.example/r");
    expect(path).toBe("projects/project");
    return { id: "project" };
  });
  const repo = await provider.viewRepo("project");
  expect(repo).toMatchObject({ host: "gerrit", nameWithOwner: "project", owner: "", visibility: "public", sshUrl: "", httpsUrl: "" });
  expect(repo).not.toHaveProperty("viewerCanPush");
  expect(repo).not.toHaveProperty("parent");
  expect(await provider.owners()).toEqual([]);
  await expect(provider.fork()).rejects.toThrow("not supported");
});
