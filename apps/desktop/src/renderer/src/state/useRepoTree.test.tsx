// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type Repo, type Result } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));

vi.mock("../lib/pwrgit", () => mocks);
vi.mock("../features/shell/dialogs", () => ({
  confirmDialog: vi.fn(),
  notifyDialog: vi.fn()
}));
vi.mock("../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));

import { useRepoTree, type UseRepoTree } from "./useRepoTree";

const repo: Repo = {
  id: "repo-1",
  name: "PwrGit",
  path: "/src/PwrGit",
  profileId: "personal",
  pinned: false,
  worktrees: []
};

let container: HTMLDivElement;
let root: Root;
let latest: UseRepoTree;
let repoChanged:
  | ((value: { profileId: string; repoIds?: string[] }) => void)
  | undefined;
let reads: Array<Promise<Result<Repo[]>>>;

function Harness() {
  latest = useRepoTree("personal");
  return <span>{latest.loadState.status}</span>;
}

function nextRead(result: Result<Repo[]>): void {
  reads.push(Promise.resolve(result));
}

beforeEach(() => {
  vi.clearAllMocks();
  reads = [];
  repoChanged = undefined;
  mocks.dispatch.mockImplementation((name: string) => {
    if (name === "repo:list") {
      const read = reads.shift();
      if (read === undefined) throw new Error("Unexpected repo:list read");
      return read;
    }
    return Promise.resolve(ok(null));
  });
  mocks.subscribe.mockImplementation((channel: string, listener: typeof repoChanged) => {
    if (channel === "repo:changed") repoChanged = listener;
    return vi.fn();
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useRepoTree", () => {
  it("asks the forge once about a repository that arrives after mount", async () => {
    const identityCalls = (): unknown[] =>
      mocks.dispatch.mock.calls
        .filter(([name]) => name === "repo:refreshIdentities")
        .map(([, req]) => req);
    const read: Repo = {
      ...repo,
      id: "repo-read",
      identity: {
        host: "github",
        hostname: "github.com",
        owner: "someone",
        name: "known",
        nameWithOwner: "someone/known",
        visibility: "public"
      }
    };
    const added: Repo = { ...repo, id: "repo-added", name: "diskhound" };

    nextRead(ok([repo]));
    await act(async () => root.render(<Harness />));
    // Mount asks about the whole profile, and the first load is covered by it.
    expect(identityCalls()).toEqual([{ profileId: "personal" }]);

    // Add folders… (and, before main asked for it, Clone…) ends in exactly
    // this repo:changed, and here
    // it lands two rows: one whose identity is already stored, and one
    // nothing has looked up. Only the second is worth a forge call.
    nextRead(ok([repo, read, added]));
    await act(async () => repoChanged?.({ profileId: "personal" }));
    expect(identityCalls()).toEqual([
      { profileId: "personal" },
      { profileId: "personal", repoIds: ["repo-added"] }
    ]);

    // Once per window: a later reload that still has no identity for it (the
    // CLI is signed out, say) must not turn every repo:changed into a spawn.
    nextRead(ok([repo, read, added]));
    await act(async () => repoChanged?.({ profileId: "personal" }));
    expect(identityCalls()).toHaveLength(2);
  });

  it("keeps optimistic data on a failed refresh and retries to a valid empty list", async () => {
    nextRead(ok([repo]));
    await act(async () => root.render(<Harness />));
    expect(latest.loadState).toEqual({ status: "ready" });

    act(() => latest.setRepoPin(repo.id, true));
    nextRead(
      err({ kind: "repo", code: "read_failed", message: "Repository index is busy." })
    );
    await act(async () => repoChanged?.({ profileId: "personal" }));

    expect(latest.loadState).toEqual({
      status: "error",
      message: "Repository index is busy."
    });
    expect(latest.repos).toEqual([{ ...repo, pinned: true }]);

    nextRead(ok([]));
    await act(async () => latest.retry());
    expect(latest.loadState).toEqual({ status: "ready" });
    expect(latest.repos).toEqual([]);
  });

  it("does not let an older reload overwrite a later retry", async () => {
    let resolveFirst!: (value: Result<Repo[]>) => void;
    let resolveSecond!: (value: Result<Repo[]>) => void;
    reads.push(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
      new Promise((resolve) => {
        resolveSecond = resolve;
      })
    );

    act(() => root.render(<Harness />));
    let retry!: Promise<void>;
    act(() => {
      retry = latest.retry();
    });
    await act(async () => {
      resolveSecond(ok([repo]));
      await retry;
    });
    await act(async () => {
      resolveFirst(ok([]));
    });

    expect(latest.loadState).toEqual({ status: "ready" });
    expect(latest.repos.map((item) => item.id)).toEqual(["repo-1"]);
  });
});

describe("repo:changed that names its repositories", () => {
  const other: Repo = { ...repo, id: "repo-2", name: "PwrSnap", path: "/src/PwrSnap" };
  const listCalls = (): unknown[] =>
    mocks.dispatch.mock.calls
      .filter(([name]) => name === "repo:list")
      .map(([, req]) => req);

  it("re-reads only those repositories and keeps every other object", async () => {
    nextRead(ok([repo, other]));
    await act(async () => root.render(<Harness />));
    const before = latest.repos;

    const fresh: Repo = { ...other, pinned: false, worktrees: [] };
    nextRead(ok([fresh]));
    await act(async () => {
      repoChanged?.({ profileId: "personal", repoIds: ["repo-2"] });
    });

    expect(listCalls().at(-1)).toEqual({
      profileId: "personal",
      repoIds: ["repo-2"]
    });
    // The untouched repository is the same object, so nothing keyed on it
    // (an expanded row's repo:refs) runs again.
    expect(latest.repos[0]).toBe(before[0]);
    expect(latest.repos[1]).toBe(fresh);
  });

  it("drops a named repository the answer leaves out (gone or hidden)", async () => {
    nextRead(ok([repo, other]));
    await act(async () => root.render(<Harness />));

    nextRead(ok([]));
    await act(async () => {
      repoChanged?.({ profileId: "personal", repoIds: ["repo-2"] });
    });
    expect(latest.repos.map((item) => item.id)).toEqual(["repo-1"]);
  });

  it("batches ids that arrive while a read is out", async () => {
    nextRead(ok([repo, other]));
    await act(async () => root.render(<Harness />));

    let answer!: (value: Result<Repo[]>) => void;
    reads.push(new Promise((resolve) => (answer = resolve)));
    nextRead(ok([repo, other]));
    await act(async () => {
      repoChanged?.({ profileId: "personal", repoIds: ["repo-1"] });
      repoChanged?.({ profileId: "personal", repoIds: ["repo-2"] });
      repoChanged?.({ profileId: "personal", repoIds: ["repo-1"] });
    });
    await act(async () => answer(ok([repo])));

    // One read for the first, one for everything that queued behind it.
    expect(listCalls().slice(1)).toEqual([
      { profileId: "personal", repoIds: ["repo-1"] },
      { profileId: "personal", repoIds: ["repo-2", "repo-1"] }
    ]);
  });

  it("still re-reads the whole profile when no repositories are named", async () => {
    nextRead(ok([repo]));
    await act(async () => root.render(<Harness />));
    nextRead(ok([repo, other]));
    await act(async () => {
      repoChanged?.({ profileId: "personal" });
    });
    expect(listCalls().at(-1)).toEqual({ profileId: "personal" });
    expect(latest.repos.map((item) => item.id)).toEqual(["repo-1", "repo-2"]);
  });
});

describe("repo:changed reads that go wrong", () => {
  const other: Repo = { ...repo, id: "repo-2", name: "PwrSnap", path: "/src/PwrSnap" };
  const listCalls = (): unknown[] =>
    mocks.dispatch.mock.calls
      .filter(([name]) => name === "repo:list")
      .map(([, req]) => req);

  it("falls back to a full read when a named read fails, so ready comes back", async () => {
    nextRead(ok([repo, other]));
    await act(async () => root.render(<Harness />));

    nextRead(err({ kind: "repo", code: "read_failed", message: "busy" }));
    nextRead(ok([repo, other]));
    await act(async () => {
      repoChanged?.({ profileId: "personal", repoIds: ["repo-2"] });
    });

    expect(listCalls().at(-1)).toEqual({ profileId: "personal" });
    expect(latest.loadState).toEqual({ status: "ready" });
  });

  it("never drains another profile's ids under the old profile's name", async () => {
    let profile = "personal";
    function Switching() {
      latest = useRepoTree(profile);
      return null;
    }
    nextRead(ok([repo]));
    await act(async () => root.render(<Switching />));

    // A named read for "personal" is still out when the window switches.
    let answer!: (value: Result<Repo[]>) => void;
    reads.push(new Promise((resolve) => (answer = resolve)));
    await act(async () => {
      repoChanged?.({ profileId: "personal", repoIds: ["repo-1"] });
    });
    nextRead(ok([other]));
    profile = "work";
    await act(async () => root.render(<Switching />));

    nextRead(ok([other]));
    await act(async () => {
      repoChanged?.({ profileId: "work", repoIds: ["repo-2"] });
    });
    await act(async () => answer(ok([])));

    const named = listCalls().filter(
      (req) => (req as { repoIds?: string[] }).repoIds !== undefined
    );
    expect(named).toEqual([
      { profileId: "personal", repoIds: ["repo-1"] },
      { profileId: "work", repoIds: ["repo-2"] }
    ]);
    expect(latest.repos.map((item) => item.id)).toEqual(["repo-2"]);
  });
});
