// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ok,
  type RepoRefs,
  type Repo,
  type TagSourceState,
  type TagStatusPage,
  type TagStatusRow,
  type TagSummary
} from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: () => () => undefined
}));
vi.mock("../../lib/toast", () => ({ showErrorToast: vi.fn(), showInfoToast: vi.fn() }));
const confirmDialogMock = vi.hoisted(() => vi.fn());
vi.mock("../shell/dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shell/dialogs")>()),
  confirmDialog: confirmDialogMock
}));
vi.mock("../../lib/copyText", () => ({ copyText: vi.fn() }));

import { RepoRefsModal } from "./RepoRefsModal";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const repo: Repo = { id: "repo-1", name: "widget", path: "/repos/widget", profileId: "profile-1", pinned: false, worktrees: [] };
const refs: RepoRefs = {
  branches: [],
  previewTags: [],
  tagCount: 3,
  remotes: [{ name: "origin", fetchUrl: "/origin.git", pushUrl: "/origin.git", previewBranches: [], branchCount: 0 }]
} as unknown as RepoRefs;

const id = (c: string): string => c.repeat(40);
const local = (name: string, objectId: string, kind: "annotated" | "lightweight" = "lightweight"): TagSummary => ({
  name,
  fullName: `refs/tags/${name}`,
  kind,
  objectId,
  objectType: kind === "annotated" ? "tag" : "commit",
  targetId: objectId,
  targetType: "commit"
});
const rows: TagStatusRow[] = [
  { name: "v2.0.0", status: "same", local: local("v2.0.0", id("a")), published: { remote: "origin", objectId: id("a"), targetId: id("a"), kind: "lightweight", available: true } },
  { name: "v1.2.3", status: "differs", local: local("v1.2.3", id("b")), published: { remote: "origin", objectId: id("c"), targetId: id("c"), kind: "lightweight", available: true } },
  { name: "nightly", status: "kept_local", local: local("nightly", id("d")), published: { remote: "origin", objectId: id("e"), targetId: id("e"), kind: "lightweight", available: true } },
  { name: "wip", status: "local_only", local: local("wip", id("f")), published: null },
  { name: "legacy/import", status: "remote_only", local: null, published: { remote: "origin", objectId: id("1"), targetId: id("1"), kind: "annotated", available: false } }
];
const source = (patch: Partial<TagSourceState> = {}): TagSourceState => ({
  remotes: ["origin"],
  primary: "origin",
  chosen: false,
  tagOpt: null,
  checkedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  publishedCount: 4,
  error: null,
  stale: false,
  ...patch
});
const page = (patch: Partial<TagSourceState> = {}): TagStatusPage => ({
  rows,
  total: rows.length,
  counts: { all: 5, differs: 1, keptLocal: 1, remoteOnly: 1, localOnly: 1 },
  source: source(patch)
});

let container: HTMLDivElement;
let root: Root;
let answer: TagStatusPage;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  answer = page();
  dispatchMock.mockImplementation((channel: string) => {
    if (channel === "repo:tagStatus") return Promise.resolve(ok(answer));
    if (channel === "tag:refreshRemote") return Promise.resolve(ok({ checked: true, source: source() }));
    if (channel === "tag:adoptRemote") return Promise.resolve(ok({ name: "v1.2.3", objectId: id("c"), targetId: id("c"), replacedRef: "refs/pwrgit/replaced-tags/1/v1.2.3" }));
    if (channel === "forge:hosts") return Promise.resolve(ok({ hosts: [], overrides: {} }));
    if (channel === "pr:openList") return Promise.resolve(ok({ forge: null, fetchedAt: null, truncated: false, entries: [], remotes: [] }));
    return Promise.resolve(ok(null));
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function open(initialTagFilter?: "differs"): Promise<void> {
  await act(async () => {
    root.render(
      <RepoRefsModal
        repo={repo}
        refs={refs}
        focusedWorktree={null}
        now={Date.now()}
        initialTab="tags"
        {...(initialTagFilter === undefined ? {} : { initialTagFilter })}
        onRefresh={() => undefined}
        onRevealWorktree={() => undefined}
        onCreateWorktree={() => undefined}
        onClose={() => undefined}
      />
    );
  });
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
  await act(async () => undefined);
}

const rowOf = (name: string): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>(".refs-tag-table__row[data-tag-status]")].find(
    (row) => row.querySelector("strong")?.textContent === name
  )!;
const button = (scope: ParentNode, name: string): HTMLButtonElement =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").includes(name)
  )!;
const click = async (target: HTMLElement): Promise<void> => {
  await act(async () => {
    target.click();
  });
  await act(async () => undefined);
};
const calls = (channel: string) => dispatchMock.mock.calls.filter(([name]) => name === channel);

describe("RepoRefsModal Tags tab — published tags", () => {
  it("names the publisher and its age, and badges only the rows that differ from it", async () => {
    await open();
    expect(container.querySelector(".refs-tag-source")?.textContent).toContain("Published tags from");
    expect(container.querySelector(".refs-tag-source")?.textContent).toContain("checked 4 min ago");
    expect(rowOf("v2.0.0").querySelector(".refs-tag-pill")).toBeNull();
    expect(rowOf("v1.2.3").querySelector(".refs-tag-pill")?.textContent).toBe("differs from origin");
    expect(rowOf("nightly").querySelector(".refs-tag-pill")?.textContent).toBe("kept local");
    expect(rowOf("wip").querySelector(".refs-tag-pill")?.textContent).toBe("local only");
    expect([...rowOf("legacy/import").querySelectorAll(".refs-tag-pill")].map((pill) => pill.textContent)).toEqual([
      "only on origin",
      "not downloaded"
    ]);
    // Both values are inspectable on a differing row.
    expect(rowOf("v1.2.3").querySelector(".refs-tag-object")?.textContent).toContain(id("b").slice(0, 12));
    expect(rowOf("v1.2.3").querySelector(".refs-tag-object")?.textContent).toContain(id("c").slice(0, 12));
    // A fresh snapshot is not re-listed on open.
    expect(calls("tag:refreshRemote")).toHaveLength(0);
  });

  it("takes origin's value only after a confirm, with both reviewed object ids", async () => {
    confirmDialogMock.mockResolvedValue(true);
    await open();
    await click(button(rowOf("v1.2.3"), "Take origin's"));
    expect(confirmDialogMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Replace local tag v1.2.3 with origin's?" }));
    expect(calls("tag:adoptRemote")[0]?.[1]).toEqual({
      repoId: "repo-1", name: "v1.2.3", remote: "origin", expectedRemoteObjectId: id("c"), expectedLocalObjectId: id("b")
    });
  });

  it("does nothing when the confirm is declined", async () => {
    confirmDialogMock.mockResolvedValue(false);
    await open();
    await click(button(rowOf("v1.2.3"), "Take origin's"));
    expect(calls("tag:adoptRemote")).toHaveLength(0);
  });

  it("records Keep local for exactly the pair shown", async () => {
    await open();
    await click(button(rowOf("v1.2.3"), "Keep local"));
    expect(calls("tag:keepLocal")[0]?.[1]).toEqual({
      repoId: "repo-1", name: "v1.2.3", remote: "origin", localObjectId: id("b"), remoteObjectId: id("c"), keep: true
    });
  });

  it("asks before downloading a tag whose history is not here, and expects no local tag", async () => {
    confirmDialogMock.mockResolvedValue(true);
    await open();
    await click(button(rowOf("legacy/import"), "Download"));
    expect(confirmDialogMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Download origin's legacy/import?" }));
    expect(calls("tag:adoptRemote")[0]?.[1]).toMatchObject({ name: "legacy/import", expectedLocalObjectId: null });
  });

  it("re-lists a stale publisher once on open, and never one that opted out", async () => {
    answer = page({ stale: true });
    await open();
    expect(calls("tag:refreshRemote").map(([, request]) => request)).toEqual([{ repoId: "repo-1", mode: "auto" }]);
    await act(async () => root.unmount());
    root = createRoot(container);
    dispatchMock.mockClear();
    answer = page({ stale: true, tagOpt: "no-tags" });
    await open();
    expect(calls("tag:refreshRemote")).toHaveLength(0);
    expect(container.querySelector(".refs-tag-source")?.textContent).toContain("tagOpt --no-tags");
    expect(button(container, "Check once")).toBeTruthy();
  });

  it("offers a choice instead of guessing when there is no origin", async () => {
    answer = { ...page({ primary: null, remotes: ["github", "mirror"], checkedAt: null, stale: false }), rows: [] };
    await open();
    expect(container.querySelector(".refs-tag-source")?.textContent).toContain("Which remote publishes this repository");
    expect(container.querySelector(".refs-tag-filters")).toBeNull();
    const select = container.querySelector<HTMLSelectElement>(".refs-tag-source__select")!;
    await act(async () => {
      select.value = "mirror";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(calls("tag:setPrimaryRemote")[0]?.[1]).toEqual({ repoId: "repo-1", remote: "mirror" });
  });

  it("filters in main, starting on Differ when the sidebar asked", async () => {
    await open("differs");
    expect(calls("repo:tagStatus").at(-1)?.[1]).toMatchObject({ filter: "differs" });
    await click(button(container, "Only on origin"));
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(calls("repo:tagStatus").at(-1)?.[1]).toMatchObject({ filter: "remoteOnly" });
  });
});
