import fc from "fast-check";
import { err, ok } from "@pwrgit/shared";
import { describe, expect, it, vi } from "vitest";
import { bulkSyncRepositories, type BulkSyncRepoInput } from "./bulk-sync";
import type { GitExec, GitExecOptions } from "./dugite";
import { PULL_OPERATION_TIMEOUT_MS } from "./pull-watchdog";

vi.mock("../logs", () => ({ logMain: vi.fn() }));

const repo: BulkSyncRepoInput = {
  id: "repo", name: "repo", path: "/bulk-cancel-fixture",
  worktrees: [{ id: "main", branch: "main", path: "/bulk-cancel-fixture" }]
};

type Probe = "remote" | "remote_config" | "status" | "state" | "branch" | "head" | "upstream_name" | "upstream_head" | "branch_remote" | "ancestry";
const probes: Probe[] = ["remote", "remote_config", "status", "state", "branch", "head", "upstream_name", "upstream_head", "branch_remote", "ancestry"];

/** Script a clean, attached branch behind its fetched upstream. The property
 * tests cancellation classification, independently of Git's state derivation. */
function scenario(intercept: (probe: Probe | "merge", options?: GitExecOptions) => Promise<boolean>) {
  let updated = false;
  const git: GitExec = async (args, _cwd, options) => {
    const command = args[0];
    const probe: Probe | "merge" | undefined = command === "remote" ? "remote" :
      command === "config" ? (args.at(-1)?.endsWith("skipFetchAll") ? "remote_config" : "branch_remote") :
      command === "status" ? "status" : command === "branch" ? "branch" :
      command === "merge-base" ? "ancestry" : command === "merge" ? "merge" :
      command === "rev-parse" ? (args.includes("--git-path") ? "state" :
        args.at(-1) === "HEAD" ? "head" : args.includes("--abbrev-ref") ? "upstream_name" : "upstream_head") : undefined;
    if (probe !== undefined && await intercept(probe, options)) {
      return err({ kind: "git", code: "aborted", message: "Stopped at a probe." });
    }
    let stdout = "";
    let exitCode = 0;
    if (probe === "remote") stdout = "origin\n";
    else if (probe === "remote_config") exitCode = 1;
    else if (probe === "branch") stdout = "main\n";
    else if (probe === "head") stdout = updated ? "upstream\n" : "local\n";
    else if (probe === "upstream_name") stdout = "origin/main\n";
    else if (probe === "upstream_head") stdout = "upstream\n";
    else if (probe === "branch_remote") stdout = "origin\n";
    else if (probe === "state") stdout = args.filter((_, i) => args[i - 1] === "--git-path").map((path) => `/nonexistent-bulk-cancel-fixture/${path}\n`).join("");
    else if (probe === "merge") updated = true;
    return ok({ stdout, stderr: "", exitCode });
  };
  return { git, updated: () => updated };
}

async function assertCancelledProbe(probe: Probe, secondInspection: boolean): Promise<void> {
  const controller = new AbortController();
  let seen = 0;
  const wanted = secondInspection && probe !== "remote" && probe !== "remote_config" ? 2 : 1;
  const { git, updated } = scenario(async (current) => {
    if (current !== probe || ++seen !== wanted) return false;
    controller.abort();
    return true;
  });
  const summary = await bulkSyncRepositories(git, [repo], {
    operationId: "cancel-probe", mode: "soft-pull", signal: controller.signal
  });
  expect(seen).toBe(wanted);
  expect(updated()).toBe(false);
  expect(summary.cancelled).toBe(true);
  expect(summary.counts.repos).toMatchObject({ failed: 0, cancelled: 1 });
  expect(summary.counts.worktrees).toMatchObject({ failed: 0, cancelled: 1 });
  expect(summary.results[0]?.worktrees[0]).toMatchObject({ outcome: "cancelled", reason: "cancelled" });
}

async function assertMutationFinishes(stage: "merge" | "verification", ending: "cancel" | "deadline"): Promise<void> {
  vi.useFakeTimers();
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let mergeStarted = false;
  let heldOptions: GitExecOptions | undefined;
  let lockHeld = false;
  let settled = false;
  const { git } = scenario(async (probe, options) => {
    const block = stage === "merge" ? probe === "merge" : probe === "head" && mergeStarted;
    if (probe === "merge") mergeStarted = true;
    if (block) {
      heldOptions = options;
      entered();
      await gate;
      return options?.signal?.aborted ?? false;
    }
    return false;
  });
  const operation = bulkSyncRepositories(git, [repo], {
    operationId: "safe-mutation", mode: "soft-pull", signal: controller.signal,
    runWorktree: async (_id, operation) => {
      lockHeld = true;
      try { return await operation(); } finally { lockHeld = false; }
    }
  }).then((summary) => { settled = true; return summary; });
  try {
    await started;
    if (ending === "cancel") controller.abort();
    await vi.advanceTimersByTimeAsync(PULL_OPERATION_TIMEOUT_MS + 1);
    expect(heldOptions?.signal, "checkout and its verification must not receive a cancellation/deadline signal").toBeUndefined();
    expect(lockHeld).toBe(true);
    expect(settled).toBe(false);
    release();
    const summary = await operation;
    expect(summary.results[0]?.worktrees[0]).toMatchObject({ outcome: "updated", afterHead: "upstream" });
    expect(lockHeld).toBe(false);
  } finally {
    release();
    await operation;
    vi.useRealTimers();
  }
}

describe("bulk cancellation safety properties", () => {
  it("classifies cancellation in every local probe and either inspection as cancellation", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(...probes), fc.boolean(), assertCancelledProbe));
  });

  it("reports cancellation during remote configuration as cancelled, not failed", async () => {
    await assertCancelledProbe("remote_config", false);
  });

  it("reports an interrupted working-tree status probe as cancelled", async () => {
    await assertCancelledProbe("status", false);
  });

  it("keeps checkout and verification under the worktree lock through cancel or expired deadlines", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("merge" as const, "verification" as const), fc.constantFrom("cancel" as const, "deadline" as const), assertMutationFinishes));
  });

  it("lets an already-started fast-forward finish after Cancel", async () => {
    await assertMutationFinishes("merge", "cancel");
  });
});
