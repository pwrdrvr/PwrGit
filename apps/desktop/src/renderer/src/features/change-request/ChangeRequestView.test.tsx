// @vitest-environment jsdom

import { act, useRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type ChangeRequestEntry, type ChangeRequestView as View } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: () => () => undefined
}));

import type { ChangeRequestPick } from "./change-request-selection";
import { ChangeRequestRail } from "./ChangeRequestRail";
import { ChangeRequestView } from "./ChangeRequestView";
import { KEYBOARD_FETCH_DWELL_MS, useChangeRequestView } from "./useChangeRequestView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const FORGE_REPO = "github.com/acme/orbit";
const entry: ChangeRequestEntry = {
  pr: {
    number: 381,
    url: "https://example.test/acme/orbit/pull/381",
    title: "Audit log export",
    state: "open",
    isDraft: false,
    forge: "github",
    author: "mara",
    headRefName: "fix/audit",
    baseRefName: "main",
    // The forge's numbers for its own head: the header shows them until git
    // answers, then counts the diff it draws.
    additions: 9,
    deletions: 4,
    changedFiles: 5
  },
  location: { kind: "unfetched", branch: "fix/audit", remote: "origin" },
  remote: "origin",
  forgeRepo: FORGE_REPO
};

const PATCH = [
  "diff --git a/src/audit.ts b/src/audit.ts",
  "index 1111111..2222222 100644",
  "--- a/src/audit.ts",
  "+++ b/src/audit.ts",
  "@@ -1,2 +1,3 @@",
  " export const a = 1;",
  "-export const b = 2;",
  "+export const b = 3;",
  "+export const c = 4;",
  "diff --git a/README.md b/README.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/README.md",
  "@@ -0,0 +1 @@",
  "+# Audit",
  ""
].join("\n");

const HEAD = "a1b2c3d4e5f6a7b8c9d0";
const fetched: ChangeRequestEntry = {
  ...entry,
  location: { kind: "remote", branch: "fix/audit", fullName: "refs/remotes/origin/fix/audit" }
};
const readyView: View = {
  state: "ready",
  entry: fetched,
  local: { oid: HEAD, holder: { kind: "remote", name: "origin/fix/audit" } },
  forge: { oid: HEAD, holder: { kind: "remote", name: "origin/fix/audit" } },
  relation: { kind: "same" },
  head: { oid: HEAD, holder: { kind: "remote", name: "origin/fix/audit" } },
  shown: "local",
  base: { name: "origin/main", oid: "bbbbbbbbbb", mergeBase: "cccccccccccc" },
  commits: [
    { hash: "d1d1d1d1d1d1d1", subject: "Export the audit log", author: "mara", at: 0 },
    { hash: "e2e2e2e2e2e2e2", subject: "Name the columns", author: "mara", at: 0 }
  ],
  commitsTruncated: false,
  patch: PATCH
};

let container: HTMLDivElement;
let root: Root;
/** What `pr:view` answers, by whether it was allowed to fetch. */
let answers: { fetch: boolean; view: View }[];

beforeEach(() => {
  answers = [];
  dispatchMock.mockImplementation((channel: string, req: { fetch?: boolean }) => {
    if (channel === "pr:view") {
      const answer = answers.find((candidate) => candidate.fetch === req.fetch) ?? answers[0];
      return Promise.resolve(ok(answer?.view));
    }
    if (channel === "diff:commit") return Promise.resolve(ok(PATCH.split("diff --git").slice(0, 2).join("diff --git")));
    return Promise.resolve(ok(undefined));
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.useRealTimers();
});

function Harness({ pick }: { pick: ChangeRequestPick }): ReactElement {
  const state = useChangeRequestView(pick, "wt-1");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <ChangeRequestView
        entry={pick.entry}
        state={state}
        manyRemotes={false}
        worktreeId="wt-1"
        now={0}
        bodyRef={bodyRef}
        onGoToWorktree={() => undefined}
        onCreateWorktree={() => undefined}
        onClose={() => undefined}
      />
      <ChangeRequestRail state={state} now={0} onFocusFile={() => undefined} onCollapse={() => undefined} />
    </>
  );
}

const pick = (via: "pointer" | "keyboard"): ChangeRequestPick => ({
  repoId: "repo-1",
  entry,
  via,
  manyRemotes: false
});
const viewCalls = (): unknown[] =>
  dispatchMock.mock.calls.filter(([channel]) => channel === "pr:view").map(([, req]) => req);
const text = (selector: string): string =>
  container.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? "";

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
}

describe("ChangeRequestView", () => {
  it("paints the header from the list at once, then fetches a clicked head and draws its diff", async () => {
    answers = [
      { fetch: false, view: { state: "needsFetch", entry, what: "origin/fix/audit" } },
      { fetch: true, view: readyView }
    ];
    await act(async () => root.render(<Harness pick={pick("pointer")} />));
    expect(text(".cr-view__title")).toBe("Audit log export");
    expect(text(".cr-view__meta")).toContain("fix/audit");
    await settle();
    expect(text(".cr-view__stat")).toBe("+3−1");
    expect(text(".cr-view__meta")).toContain("2 files");
    expect(text(".cr-view__meta")).toContain("2 commits");

    expect(viewCalls()).toEqual([
      { repoId: "repo-1", number: 381, forgeRepo: FORGE_REPO, fetch: false },
      { repoId: "repo-1", number: 381, forgeRepo: FORGE_REPO, fetch: true }
    ]);
    expect(text(".cr-view__src")).toBe(
      "origin/fix/audit holds a1b2c3d, the head GitHub shows."
    );
    expect(container.querySelector(".cr-view__src")?.classList.contains("is-ok")).toBe(true);
    expect([...container.querySelectorAll(".diff-file")].map((file) => file.getAttribute("data-path"))).toEqual([
      "src/audit.ts",
      "README.md"
    ]);
    // The rail lists what the main pane draws.
    expect([...container.querySelectorAll(".cr-rail__path")].map((path) => path.textContent)).toEqual([
      "src/audit.ts",
      "README.md"
    ]);
    // Fetched now, so the verb is + Worktree.
    expect(text(".cr-view__verb")).toContain("Worktree");
  });

  it("waits for the arrow keys to rest before fetching", async () => {
    vi.useFakeTimers();
    answers = [
      { fetch: false, view: { state: "needsFetch", entry, what: "origin/fix/audit" } },
      { fetch: true, view: readyView }
    ];
    await act(async () => root.render(<Harness pick={pick("keyboard")} />));
    await settle();
    expect(viewCalls()).toHaveLength(1);
    expect(text(".cr-view__src")).toContain("Fetching origin/fix/audit");
    // Nothing drawn yet: the forge's own numbers.
    expect(text(".cr-view__stat")).toBe("+9−4");

    await act(async () => vi.advanceTimersByTime(KEYBOARD_FETCH_DWELL_MS));
    await settle();
    expect(viewCalls()).toHaveLength(2);
    expect(container.querySelector(".cr-view__src")?.classList.contains("is-ok")).toBe(true);
  });

  it("draws one commit when the rail picks it, and says so above it", async () => {
    answers = [{ fetch: false, view: readyView }];
    await act(async () => root.render(<Harness pick={pick("pointer")} />));
    await settle();
    expect(viewCalls()).toHaveLength(1);

    const commitsTab = [...container.querySelectorAll<HTMLButtonElement>(".rail-tab")].find((tab) =>
      tab.textContent?.startsWith("Commits")
    );
    await act(async () => commitsTab?.click());
    const commit = [...container.querySelectorAll<HTMLButtonElement>(".cr-rail__item")].find((row) =>
      row.textContent?.includes("Name the columns")
    );
    await act(async () => commit?.click());
    await settle();

    expect(dispatchMock).toHaveBeenCalledWith("diff:commit", { worktreeId: "wt-1", hash: "e2e2e2e2e2e2e2" });
    expect(text(".cr-view__scope-hash")).toBe("e2e2e2e");
    expect(text(".cr-view__scope-subject")).toBe("Name the columns");
    expect(commit?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll(".diff-file")).toHaveLength(1);
    expect(text(".cr-rail__base-ref")).toBe("origin/main · merge base ccccccc");
  });
});
