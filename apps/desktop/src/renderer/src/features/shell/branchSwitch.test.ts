import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
const chooseDialog = vi.hoisted(() => vi.fn());
const showErrorToast = vi.hoisted(() => vi.fn());
const showInfoToast = vi.hoisted(() => vi.fn());

vi.mock("../../lib/pwrgit", () => ({ dispatch }));
vi.mock("./dialogs", () => ({ chooseDialog }));
vi.mock("../../lib/toast", () => ({ showErrorToast, showInfoToast }));

const {
  askDirtyIntent,
  askOverwriteIntent,
  dirtyFacts,
  dirtySwitchMessage,
  guardedSwitchBranch,
  offerLeftChanges,
  readDirtyState,
  restoreLeftChanges,
  switchWorktreeToBranch
} = await import("./branchSwitch");

/**
 * Replies queued per command, so a test says what each command answers rather
 * than guessing the order the code asks in. `stash:list` defaults to an empty
 * stack: every successful switch looks for changes left on its destination.
 */
let replies: Map<string, unknown[]>;
function answer(name: string, ...values: unknown[]): void {
  replies.set(name, [...(replies.get(name) ?? []), ...values]);
}
const callsTo = (name: string): unknown[] =>
  dispatch.mock.calls.filter(([called]) => called === name).map(([, req]) => req);

/** `changes:list`, which the prompt reads to name the files at stake. */
const changeSet = (...paths: string[]) => ({
  ok: true as const,
  value: { staged: [], unstaged: paths.map((path) => ({ path })) }
});

const dirtyResult = (dirty: number) => ({
  ok: true as const,
  value: { dirty }
});

const switched = (value: { carried?: boolean; left?: boolean } = {}) => ({
  ok: true as const,
  value: { carried: value.carried ?? false, left: value.left ?? false }
});

const wouldOverwrite = (...paths: string[]) => ({
  ok: false as const,
  error: {
    kind: "repo",
    code: "switch_would_overwrite",
    message:
      "error: Your local changes to the following files would be overwritten by checkout:",
    paths
  }
});

const stashEntry = (hash: string, name: string) => ({
  selector: "stash@{0}",
  hash,
  occurrenceCount: 1,
  shortHash: hash.slice(0, 7),
  baseHash: "0".repeat(40),
  branch: "main",
  subject: `On main: ${name}`,
  name,
  kind: "ordinary",
  createdAt: "2026-10-01T00:00:00Z"
});

beforeEach(() => {
  dispatch.mockReset();
  chooseDialog.mockReset();
  showErrorToast.mockReset();
  showInfoToast.mockReset();
  replies = new Map();
  dispatch.mockImplementation(async (name: string) => {
    const queue = replies.get(name);
    if (queue !== undefined && queue.length > 0) return queue.shift();
    if (name === "stash:list") return { ok: true, value: [] };
    throw new Error(`unexpected dispatch: ${name}`);
  });
});

describe("readDirtyState", () => {
  it("reads a clean tree from the live checkout-safety probe", async () => {
    answer("worktree:readDirty", dirtyResult(0));
    await expect(readDirtyState("wt-1")).resolves.toEqual({
      kind: "clean"
    });
    expect(dispatch).toHaveBeenCalledWith("worktree:readDirty", {
      worktreeId: "wt-1"
    });
  });

  it("counts parent and initialized-child changes", async () => {
    answer("worktree:readDirty", dirtyResult(12));
    await expect(readDirtyState("wt-1")).resolves.toEqual({
      kind: "dirty",
      files: 12
    });
  });

  it("treats a failed read as unknown, not clean", async () => {
    answer("worktree:readDirty", {
      ok: false,
      error: { kind: "repo", code: "not_found", message: "gone" }
    });
    await expect(readDirtyState("wt-1")).resolves.toEqual({
      kind: "unknown"
    });
  });
});

describe("dirtySwitchMessage", () => {
  // The question is where the work goes, which both answers then name.
  it("asks where the changes should go", () => {
    expect(dirtySwitchMessage({ kind: "dirty", files: 3 }, "PwrSnap")).toBe(
      "PwrSnap has 3 uncommitted changes. Where should they go?"
    );
  });

  it("keeps the count singular for one file", () => {
    expect(dirtySwitchMessage({ kind: "dirty", files: 1 }, "PwrSnap")).toBe(
      "PwrSnap has 1 uncommitted change. Where should they go?"
    );
  });

  it("admits when it could not count", () => {
    expect(dirtySwitchMessage({ kind: "unknown" }, "PwrSnap")).toContain(
      "uncommitted changes PwrGit could not count"
    );
  });
});

/**
 * The first question. Its whole job is to name the two places the work can go,
 * so the wording is the feature — and neither answer commits anything.
 */
describe("askDirtyIntent", () => {
  const ask = (from = "main") =>
    askDirtyIntent({ kind: "dirty", files: 3 }, "PwrSnap", from, "feature/x", [
      "src/a.ts"
    ]);

  it("offers bring first, then leave, each with what it does", async () => {
    chooseDialog.mockResolvedValueOnce("bring");
    await ask();
    const opts = chooseDialog.mock.calls[0]?.[0];
    expect(opts.title).toBe("Switch to feature/x?");
    expect(opts.message).toBe(
      "PwrSnap has 3 uncommitted changes. Where should they go?"
    );
    expect(opts.facts).toEqual(["src/a.ts"]);
    expect(opts.cancelLabel).toBe("Cancel");
    // First is the default and takes focus.
    expect(opts.choices.map((c: { id: string }) => c.id)).toEqual([
      "bring",
      "leave"
    ]);
    expect(opts.choices.map((c: { label: string }) => c.label)).toEqual([
      "Bring my changes to feature/x",
      "Leave my changes on main"
    ]);
    expect(opts.choices[0].detail).toBe(
      "They stay in the folder as they are. If feature/x has its own version of one of these files, PwrGit tells you before anything moves."
    );
    expect(opts.choices[1].detail).toBe(
      "PwrGit stashes them with main. Come back to main and PwrGit offers to put them back."
    );
  });

  it("never offers to commit", async () => {
    chooseDialog.mockResolvedValueOnce(null);
    await ask();
    const labels = chooseDialog.mock.calls[0]?.[0].choices.map(
      (c: { label: string }) => c.label
    );
    expect(labels.join(" ")).not.toMatch(/commit/i);
  });

  it.each([
    ["bring", "bring"],
    ["leave", "leave"]
  ])("passes %s through", async (picked, expected) => {
    chooseDialog.mockResolvedValueOnce(picked);
    await expect(ask()).resolves.toBe(expected);
  });

  // Escape, the backdrop, and the Cancel button all arrive as null.
  it("treats a dismissed prompt as cancel", async () => {
    chooseDialog.mockResolvedValueOnce(null);
    await expect(ask()).resolves.toBe("cancel");
  });

  // `Worktree.branch` is not always a branch name, and a detached checkout has
  // no branch to come back to — so the stash is offered from the Stashes tab.
  it.each(["detached@ab12cd", "(bare)", "(unknown)", ""])(
    "does not print the %j sentinel as a branch",
    async (sentinel) => {
      chooseDialog.mockResolvedValueOnce(null);
      await ask(sentinel);
      const leave = chooseDialog.mock.calls[0]?.[0].choices[1];
      expect(leave.id).toBe("leave");
      expect(leave.label).toBe("Leave my changes in the stash");
      expect(leave.detail).toContain("Stashes tab");
      if (sentinel !== "") expect(leave.detail).not.toContain(sentinel);
    }
  );
});

/** The second question, asked only after Git refused to bring the work. */
describe("askOverwriteIntent", () => {
  it("names the destination and the files, and offers merge first", async () => {
    chooseDialog.mockResolvedValueOnce("merge");
    await expect(
      askOverwriteIntent("main", "feature/x", ["src/a.ts", "README.md"])
    ).resolves.toBe("merge");
    const opts = chooseDialog.mock.calls[0]?.[0];
    expect(opts.title).toBe("feature/x has its own version of these files");
    expect(opts.message).toBe(
      "Switching would overwrite your changes to them, so nothing has moved yet."
    );
    expect(opts.facts).toEqual(["src/a.ts", "README.md"]);
    expect(opts.choices.map((c: { label: string }) => c.label)).toEqual([
      "Merge my changes into feature/x's",
      "Leave my changes on main"
    ]);
    // The promise the carrying switch's rollback keeps, stated up front.
    expect(opts.choices[0].detail).toContain("nothing moves");
    expect(opts.choices[0].detail).toContain("you stay on main");
  });

  it("speaks of one file as one file", async () => {
    chooseDialog.mockResolvedValueOnce(null);
    await expect(
      askOverwriteIntent("main", "feature/x", ["src/a.ts"])
    ).resolves.toBe("cancel");
    const opts = chooseDialog.mock.calls[0]?.[0];
    expect(opts.title).toBe("feature/x has its own version of this file");
    expect(opts.message).toContain("your changes to it,");
  });

  it("caps a long list the way the first prompt does", async () => {
    chooseDialog.mockResolvedValueOnce("leave");
    const paths = ["a", "b", "c", "d", "e", "f", "g"];
    await expect(askOverwriteIntent("main", "feature/x", paths)).resolves.toBe(
      "leave"
    );
    expect(chooseDialog.mock.calls[0]?.[0].facts).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "…and 2 more"
    ]);
  });

  // Git's message could not be read for paths; the question still stands.
  it("still asks when Git named no files PwrGit could read", async () => {
    chooseDialog.mockResolvedValueOnce(null);
    await askOverwriteIntent("detached@ab12", "feature/x", []);
    const opts = chooseDialog.mock.calls[0]?.[0];
    expect(opts.facts).toEqual([]);
    expect(opts.message).toContain("some of them");
    expect(opts.choices[0].detail).toContain("you stay on this checkout");
    expect(opts.choices[1].label).toBe("Leave my changes in the stash");
  });
});

describe("guardedSwitchBranch", () => {
  const args = {
    worktreeId: "wt-1",
    worktreeLabel: "PwrSnap",
    fromBranch: "main",
    branch: "feature/x"
  };
  /** A dirty checkout: the probe, then the files the prompt lists. */
  const dirtyTree = (files = 4) => {
    answer("worktree:readDirty", dirtyResult(files));
    answer("changes:list", changeSet("a.ts", "b.ts"));
  };

  it("switches without a prompt when the tree is clean", async () => {
    answer("worktree:readDirty", dirtyResult(0));
    answer("branch:switch", switched());
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched",
      carried: false,
      left: false
    });
    expect(chooseDialog).not.toHaveBeenCalled();
    expect(callsTo("branch:switch")).toEqual([
      { worktreeId: "wt-1", branch: "feature/x" }
    ]);
  });

  // Bring is a plain switch: Git carries what it can, and no stash is made.
  it("brings the changes with a plain switch", async () => {
    dirtyTree();
    answer("branch:switch", switched());
    chooseDialog.mockResolvedValueOnce("bring");
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched",
      carried: false,
      left: false
    });
    expect(chooseDialog).toHaveBeenCalledOnce();
    expect(callsTo("branch:switch")).toEqual([
      { worktreeId: "wt-1", branch: "feature/x" }
    ]);
  });

  it("leaves the changes behind when that is what the reader picked", async () => {
    dirtyTree();
    answer("branch:switch", switched({ left: true }));
    chooseDialog.mockResolvedValueOnce("leave");
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched",
      carried: false,
      left: true
    });
    expect(callsTo("branch:switch")).toEqual([
      { worktreeId: "wt-1", branch: "feature/x", changes: "leave" }
    ]);
  });

  it("does not switch when the prompt is dismissed", async () => {
    dirtyTree();
    chooseDialog.mockResolvedValueOnce(null);
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "cancelled"
    });
    expect(callsTo("branch:switch")).toEqual([]);
  });

  // "Tells you before anything moves": the refusal moved nothing, and the
  // second question is about exactly the files Git named.
  it("asks about the files Git would overwrite, then merges them in", async () => {
    dirtyTree();
    answer(
      "branch:switch",
      wouldOverwrite("src/a.ts"),
      switched({ carried: true })
    );
    chooseDialog.mockResolvedValueOnce("bring").mockResolvedValueOnce("merge");
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched",
      carried: true,
      left: false
    });
    const second = chooseDialog.mock.calls[1]?.[0];
    expect(second.title).toBe("feature/x has its own version of this file");
    expect(second.facts).toEqual(["src/a.ts"]);
    expect(callsTo("branch:switch")).toEqual([
      { worktreeId: "wt-1", branch: "feature/x" },
      { worktreeId: "wt-1", branch: "feature/x", changes: "merge" }
    ]);
  });

  it("leaves the changes behind when the refusal is answered that way", async () => {
    dirtyTree();
    answer(
      "branch:switch",
      wouldOverwrite("src/a.ts", "src/b.ts"),
      switched({ left: true })
    );
    chooseDialog.mockResolvedValueOnce("bring").mockResolvedValueOnce("leave");
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched",
      carried: false,
      left: true
    });
    expect(callsTo("branch:switch")).toEqual([
      { worktreeId: "wt-1", branch: "feature/x" },
      { worktreeId: "wt-1", branch: "feature/x", changes: "leave" }
    ]);
  });

  it("does nothing more when the refusal's question is cancelled", async () => {
    dirtyTree();
    answer("branch:switch", wouldOverwrite("src/a.ts"));
    chooseDialog.mockResolvedValueOnce("bring").mockResolvedValueOnce(null);
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "cancelled"
    });
    expect(callsTo("branch:switch")).toHaveLength(1);
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  // The tree was clean at the probe and dirty by the switch. Git's refusal is
  // still the honest moment to ask, rather than a failure toast.
  it("asks about a refusal even when the probe saw a clean tree", async () => {
    answer("worktree:readDirty", dirtyResult(0));
    answer("branch:switch", wouldOverwrite("src/a.ts"));
    chooseDialog.mockResolvedValueOnce(null);
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "cancelled"
    });
    expect(chooseDialog).toHaveBeenCalledOnce();
    expect(chooseDialog.mock.calls[0]?.[0].title).toContain(
      "has its own version"
    );
  });

  // The merge's rollback already put everything back; its code says so.
  it("passes a merge that could not land through as its own code", async () => {
    dirtyTree();
    answer("branch:switch", wouldOverwrite("src/a.ts"), {
      ok: false,
      error: {
        kind: "repo",
        code: "carry_conflicts",
        message: "Your changes conflict with feature/x"
      }
    });
    chooseDialog.mockResolvedValueOnce("bring").mockResolvedValueOnce("merge");
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "failed",
      code: "carry_conflicts",
      message: "Your changes conflict with feature/x"
    });
  });

  it("asks when dirtiness could not be read", async () => {
    answer("worktree:readDirty", {
      ok: false,
      error: { kind: "git", code: "exit_128", message: "status failed" }
    });
    answer("changes:list", changeSet("a.ts"));
    answer("branch:switch", switched());
    chooseDialog.mockResolvedValueOnce("bring");
    await expect(guardedSwitchBranch(args)).resolves.toMatchObject({
      kind: "switched"
    });
    expect(chooseDialog).toHaveBeenCalledOnce();
  });

  // Every answer is the wrong question for a directory that does not exist:
  // there is nothing to switch and nothing to carry.
  it("refuses a gone checkout without asking anything", async () => {
    answer("worktree:readDirty", {
      ok: false,
      error: {
        kind: "repo",
        code: "worktree_missing",
        message: "This worktree's folder no longer exists: /wt/gone."
      }
    });
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "failed",
      code: "worktree_missing",
      message: "This worktree's folder no longer exists: /wt/gone."
    });
    expect(chooseDialog).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("skips the state read entirely when the caller already asked", async () => {
    answer("branch:switch", switched());
    await expect(
      guardedSwitchBranch({ ...args, skipDirtyConfirm: true })
    ).resolves.toEqual({ kind: "switched", carried: false, left: false });
    expect(callsTo("worktree:readDirty")).toEqual([]);
    expect(callsTo("branch:switch")).toEqual([
      { worktreeId: "wt-1", branch: "feature/x" }
    ]);
  });

  // Occupancy is decided upstream from a refs snapshot that a second window or
  // a terminal can invalidate. A collision is therefore expected, not an error:
  // the caller goes to whichever worktree holds the branch now.
  it("reports a lost race as held rather than failed", async () => {
    answer("worktree:readDirty", dirtyResult(0));
    answer("branch:switch", {
      ok: false,
      error: {
        kind: "repo",
        code: "checked_out_elsewhere",
        message: "fatal: 'feature/x' is already used by worktree at '/repos/b'"
      }
    });
    await expect(guardedSwitchBranch(args)).resolves.toEqual({ kind: "held" });
  });

  it("offers back the changes left on the destination", async () => {
    answer("worktree:readDirty", dirtyResult(0));
    answer("branch:switch", switched());
    answer("stash:list", {
      ok: true,
      value: [stashEntry("a".repeat(40), "pwrgit: left on feature/x")]
    });
    answer("stash:details", {
      ok: true,
      value: { files: [{ path: "a.ts" }, { path: "b.ts" }] }
    });
    await guardedSwitchBranch(args);
    await vi.waitFor(() => expect(showInfoToast).toHaveBeenCalledOnce());
    expect(showInfoToast.mock.calls[0]?.[0].message).toBe(
      "You left 2 changes on feature/x."
    );
  });

  // Best-effort: the switch already happened, and losing the offer is all a
  // failed read may cost.
  it("keeps the switch when the stash cannot be read", async () => {
    answer("worktree:readDirty", dirtyResult(0));
    answer("branch:switch", switched());
    answer("stash:list", {
      ok: false,
      error: { kind: "git", code: "exit_128", message: "no" }
    });
    await expect(guardedSwitchBranch(args)).resolves.toMatchObject({
      kind: "switched"
    });
    await vi.waitFor(() => expect(callsTo("stash:list")).toHaveLength(1));
    expect(showInfoToast).not.toHaveBeenCalled();
    expect(showErrorToast).not.toHaveBeenCalled();
  });
});

describe("offerLeftChanges", () => {
  const LEFT = "b".repeat(40);

  it("offers the newest entry left on exactly this branch", async () => {
    answer("stash:list", {
      ok: true,
      value: [
        stashEntry("c".repeat(40), "pwrgit: left on main-2"),
        stashEntry("d".repeat(40), "left on main"),
        stashEntry(LEFT, "pwrgit: left on main"),
        stashEntry("e".repeat(40), "pwrgit: left on main")
      ]
    });
    answer("stash:details", {
      ok: true,
      value: { files: [{ path: "a.ts" }] }
    });
    await offerLeftChanges("wt-1", "main");

    expect(callsTo("stash:details")).toEqual([
      { worktreeId: "wt-1", stashHash: LEFT }
    ]);
    const toast = showInfoToast.mock.calls[0]?.[0];
    expect(toast.title).toBe("Your changes are waiting");
    expect(toast.message).toBe("You left 1 change on main.");
    expect(toast.subject).toEqual({ worktreeId: "wt-1" });
    expect(toast.action.label).toBe("Restore");
  });

  it("restores by commit identity when the action runs", async () => {
    answer("stash:list", {
      ok: true,
      value: [stashEntry(LEFT, "pwrgit: left on main")]
    });
    answer("stash:details", { ok: true, value: { files: [] } });
    answer("stash:pop", { ok: true, value: null });
    await offerLeftChanges("wt-1", "main");
    // A count of nothing is not printed as "0 changes".
    expect(showInfoToast.mock.calls[0]?.[0].message).toBe(
      "You left changes on main."
    );

    showInfoToast.mock.calls[0]?.[0].action.run();
    await vi.waitFor(() =>
      expect(callsTo("stash:pop")).toEqual([
        { worktreeId: "wt-1", stashHash: LEFT }
      ])
    );
    await vi.waitFor(() => expect(showInfoToast).toHaveBeenCalledTimes(2));
    expect(showInfoToast.mock.calls[1]?.[0].message).toBe(
      "Your changes are back on main."
    );
  });

  it("stays quiet when nothing was left here", async () => {
    answer("stash:list", {
      ok: true,
      value: [stashEntry(LEFT, "pwrgit: left on feature/x")]
    });
    await offerLeftChanges("wt-1", "main");
    expect(showInfoToast).not.toHaveBeenCalled();
  });

  it("still offers when the entry's files cannot be counted", async () => {
    answer("stash:list", {
      ok: true,
      value: [stashEntry(LEFT, "pwrgit: left on main")]
    });
    answer("stash:details", {
      ok: false,
      error: { kind: "repo", code: "not_found", message: "gone" }
    });
    await offerLeftChanges("wt-1", "main");
    expect(showInfoToast.mock.calls[0]?.[0].message).toBe(
      "You left changes on main."
    );
  });

  it("never throws, even when the bridge does", async () => {
    dispatch.mockRejectedValueOnce(new Error("bridge gone"));
    await expect(offerLeftChanges("wt-1", "main")).resolves.toBeUndefined();
    expect(showInfoToast).not.toHaveBeenCalled();
  });
});

describe("restoreLeftChanges", () => {
  // `stash:pop` drops the entry only after a clean apply, so a failure keeps
  // it — and the toast says where it is.
  it("reports a failed restore and where the changes still are", async () => {
    answer("stash:pop", {
      ok: false,
      error: {
        kind: "git",
        code: "exit_1",
        message: "CONFLICT (content): Merge conflict in a.ts\nmore"
      }
    });
    await expect(restoreLeftChanges("wt-1", "main", "b".repeat(40))).resolves.toBe(
      false
    );
    const toast = showErrorToast.mock.calls[0]?.[0];
    expect(toast.title).toBe("Could not restore your changes");
    expect(toast.message).toBe(
      'CONFLICT (content): Merge conflict in a.ts They are still in the stash as "pwrgit: left on main".'
    );
    expect(toast.detail).toContain("more");
    expect(toast.subject).toEqual({ worktreeId: "wt-1" });
    expect(showInfoToast).not.toHaveBeenCalled();
  });
});

/**
 * The gesture every branch list now shares. The two outcomes worth pinning are
 * the ones that are NOT failures: a lost occupancy race resolves into a
 * navigation, and a declined prompt leaves the world alone.
 */
describe("switchWorktreeToBranch", () => {
  const onRevealWorktree = vi.fn();
  const onRefs = vi.fn();
  const args = {
    repoId: "repo-1",
    worktreeId: "wt-1",
    worktreeLabel: "PwrSnap",
    fromBranch: "main",
    branch: "feature/x",
    onRevealWorktree,
    onRefs
  };

  const refsWith = (checkedOutWorktreeIds: string[]) => ({
    ok: true as const,
    value: {
      branches: [
        {
          name: "feature/x",
          fullName: "refs/heads/feature/x",
          head: "0".repeat(40),
          ahead: 0,
          behind: 0,
          tracking: "up_to_date",
          checkedOutWorktreeIds
        }
      ],
      previewTags: [],
      tagCount: 0,
      remotes: []
    }
  });
  const held = {
    ok: false,
    error: {
      kind: "repo",
      code: "checked_out_elsewhere",
      message: "fatal: already used by worktree at '/repos/b'"
    }
  };

  beforeEach(() => {
    onRevealWorktree.mockReset();
    onRefs.mockReset();
  });

  it("reports a clean switch and raises nothing", async () => {
    answer("worktree:readDirty", dirtyResult(0));
    answer("branch:switch", switched());
    await expect(switchWorktreeToBranch(args)).resolves.toBe("switched");
    expect(showErrorToast).not.toHaveBeenCalled();
    expect(onRevealWorktree).not.toHaveBeenCalled();
  });

  // The whole point of resolving `held` here: git refuses the second checkout,
  // and its refusal names a path, not an id — so the fresh snapshot is what
  // turns "someone else has it" into "go here".
  it("takes the caller to whoever holds the branch now", async () => {
    answer("worktree:readDirty", dirtyResult(0));
    answer("branch:switch", held);
    answer("repo:refs", refsWith(["wt-2"]));
    await expect(switchWorktreeToBranch(args)).resolves.toBe("revealed");
    expect(onRevealWorktree).toHaveBeenCalledWith("wt-2");
    expect(onRefs).toHaveBeenCalledOnce();
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  // The re-read is not free, and the caller is holding the snapshot it just
  // invalidated — handing it back is what keeps the row states honest.
  it("hands the refreshed snapshot back to the caller", async () => {
    answer("worktree:readDirty", dirtyResult(0));
    answer("branch:switch", held);
    answer("repo:refs", refsWith(["wt-2"]));
    await switchWorktreeToBranch(args);
    expect(onRefs.mock.calls[0]?.[0]?.branches?.[0]?.name).toBe("feature/x");
  });

  // A branch that was held a moment ago and is held by nobody now means the
  // snapshot moved under us twice. There is no worktree to go to, so say so.
  it("falls back to a message when the holder has since vanished", async () => {
    answer("worktree:readDirty", dirtyResult(0));
    answer("branch:switch", held);
    answer("repo:refs", refsWith([]));
    await expect(switchWorktreeToBranch(args)).resolves.toBe("failed");
    expect(onRevealWorktree).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledOnce();
  });

  it("says nothing moved when a merge could not land", async () => {
    answer("worktree:readDirty", dirtyResult(2));
    answer("changes:list", changeSet("a.ts"));
    answer("branch:switch", wouldOverwrite("a.ts"), {
      ok: false,
      error: {
        kind: "repo",
        code: "carry_conflicts",
        message: "Your changes conflict with feature/x. Nothing moved."
      }
    });
    chooseDialog.mockResolvedValueOnce("bring").mockResolvedValueOnce("merge");
    await expect(switchWorktreeToBranch(args)).resolves.toBe("failed");
    expect(showErrorToast.mock.calls[0]?.[0]?.title).toBe(
      "Your changes stayed put"
    );
  });

  it("stays quiet when the dirty prompt is dismissed", async () => {
    answer("worktree:readDirty", dirtyResult(3));
    answer("changes:list", changeSet("a.ts"));
    chooseDialog.mockResolvedValueOnce(null);
    await expect(switchWorktreeToBranch(args)).resolves.toBe("cancelled");
    expect(showErrorToast).not.toHaveBeenCalled();
    expect(onRevealWorktree).not.toHaveBeenCalled();
  });
});

describe("dirtyFacts", () => {
  it("names the files at stake, staged ones first", async () => {
    answer("changes:list", {
      ok: true,
      value: {
        staged: [{ path: "src/staged.ts" }],
        unstaged: [{ path: "src/loose.ts" }]
      }
    });
    await expect(dirtyFacts("wt-1")).resolves.toEqual([
      "src/staged.ts",
      "src/loose.ts"
    ]);
  });

  // A file that is both staged and further modified is one file to the reader.
  it("counts a partially staged file once", async () => {
    answer("changes:list", {
      ok: true,
      value: { staged: [{ path: "both.ts" }], unstaged: [{ path: "both.ts" }] }
    });
    await expect(dirtyFacts("wt-1")).resolves.toEqual(["both.ts"]);
  });

  // `changes:list` caps its rows and carries the real totals in `truncated`.
  // Counting the remainder off the capped array undercounts exactly when the
  // number matters — a regenerated lockfile, a reformatted tree.
  it("counts the overflow from the real totals, not the capped rows", async () => {
    answer("changes:list", {
      ok: true,
      value: {
        staged: [],
        unstaged: ["a", "b", "c", "d", "e", "f"].map((path) => ({ path })),
        truncated: { staged: 0, unstaged: 500, largestUntrackedFolder: null }
      }
    });
    await expect(dirtyFacts("wt-1", 5)).resolves.toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "…and 495 more"
    ]);
  });

  it("says how many it is not listing", async () => {
    answer("changes:list", changeSet("a", "b", "c", "d", "e", "f", "g"));
    await expect(dirtyFacts("wt-1", 5)).resolves.toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "…and 2 more"
    ]);
  });

  // Best-effort: losing the list must not lose the prompt, which is the part
  // that actually protects the work.
  it("costs the list and not the prompt when it cannot be read", async () => {
    answer("changes:list", {
      ok: false,
      error: { kind: "git", code: "exit_128", message: "no" }
    });
    await expect(dirtyFacts("wt-1")).resolves.toEqual([]);
  });
});
