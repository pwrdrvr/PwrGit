import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { err, ok } from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import { pullFastForward } from "./git-service";
import { createSystemGit } from "./test-support/system-git";
import { listStashes } from "./stash-service";

const systemGit = createSystemGit();
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await systemGit(args, cwd);
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.exitCode !== 0) throw new Error(result.value.stderr);
  return result.value.stdout.trim();
}

async function fixture(conflict = false) {
  const root = await mkdtemp(join(tmpdir(), "pwrgit-pull-owner-"));
  roots.push(root);
  const upstream = join(root, "upstream");
  const local = join(root, "local");
  const sibling = join(root, "sibling");
  await git(root, "init", "-b", "main", upstream);
  await git(upstream, "config", "user.name", "Test");
  await git(upstream, "config", "user.email", "test@example.invalid");
  await git(upstream, "config", "core.autocrlf", "false");
  await writeFile(join(upstream, "own.txt"), "base own\n");
  await writeFile(join(upstream, "sibling.txt"), "base sibling\n");
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-m", "base");
  await git(root, "-c", "core.autocrlf=false", "clone", upstream, local);
  await git(local, "config", "user.name", "Test");
  await git(local, "config", "user.email", "test@example.invalid");
  await git(local, "config", "core.autocrlf", "false");
  await git(local, "worktree", "add", "-b", "side", sibling);
  const originalHead = await git(local, "rev-parse", "HEAD");
  await writeFile(join(upstream, conflict ? "own.txt" : "incoming.txt"), "upstream work\n");
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-m", "advance upstream");
  await writeFile(join(local, "own.txt"), "staged own\n");
  await git(local, "add", "own.txt");
  if (!conflict) await writeFile(join(local, "own.txt"), "staged own\nunstaged own\n");
  await writeFile(join(local, "untracked.txt"), "own untracked\n");
  await writeFile(join(sibling, "sibling.txt"), "foreign work\n");
  const staged = await git(local, "diff", "--cached");
  const unstaged = await git(local, "diff");
  let foreignSha = "";
  const pushForeign = async () => {
    await git(sibling, "stash", "push", "-m", "foreign sibling recovery");
    foreignSha = await git(sibling, "rev-parse", "refs/stash");
  };
  const assertForeign = async () => {
    expect(foreignSha).not.toBe("");
    expect(await git(local, "stash", "list", "--format=%H")).toContain(foreignSha);
    expect(await readFile(join(local, "sibling.txt"), "utf8")).toBe("base sibling\n");
    expect(await git(local, "show", `${foreignSha}:sibling.txt`)).toBe("foreign work");
  };
  const assertRestored = async () => {
    expect(await git(local, "diff", "--cached")).toBe(staged);
    expect(await git(local, "diff")).toBe(unstaged);
    expect(await readFile(join(local, "untracked.txt"), "utf8")).toBe("own untracked\n");
  };
  return { local, sibling, originalHead, pushForeign, assertForeign, assertRestored };
}

describe("Pull owns its recovery stash across linked worktrees", () => {
  it.each(["after push", "at fast_forward", "before restore"])("restores its own indexed work when a sibling pushes %s", async (when) => {
    const f = await fixture();
    let siblingPush: Promise<void> | undefined;
    const interleaved: GitExec = async (args, cwd, options) => {
      if (args[0] === "merge") await siblingPush;
      const result = await systemGit(args, cwd, options);
      if ((when === "after push" && args[0] === "stash" && args[1] === "push") ||
          (when === "before restore" && args[0] === "merge")) await f.pushForeign();
      return result;
    };
    const result = await pullFastForward(interleaved, f.local, (phase) => {
      if (when === "at fast_forward" && phase === "fast_forward") siblingPush = f.pushForeign();
    });
    await f.assertRestored();
    await f.assertForeign();
    expect(result).toMatchObject({ ok: true, value: { reappliedWithConflicts: false, recoveryStash: expect.any(String) } });
    expect((await git(f.local, "stash", "list", "--format=%H")).split("\n")).toHaveLength(2);
    const entries = await listStashes(systemGit, f.local);
    expect(entries).toMatchObject({ ok: true, value: expect.arrayContaining([
      expect.objectContaining({ kind: "pwrgit-pull-recovery" })
    ]) });
  });

  it("uses the same owned commit for the plain conflict fallback after another sibling push", async () => {
    const f = await fixture(true);
    let indexedFailed = false;
    const interleaved: GitExec = async (args, cwd, options) => {
      const result = await systemGit(args, cwd, options);
      if (args[0] === "stash" && ["apply", "pop"].includes(args[1] ?? "") && args.includes("--index")) {
        indexedFailed = result.ok && result.value.exitCode !== 0;
        await f.pushForeign();
      }
      return result;
    };
    const result = await pullFastForward(interleaved, f.local);
    expect(indexedFailed).toBe(true);
    expect(result).toMatchObject({ ok: true, value: { reappliedWithConflicts: true, recoveryStash: expect.any(String) } });
    expect(await git(f.local, "diff", "--name-only", "--diff-filter=U")).toBe("own.txt");
    expect(await readFile(join(f.local, "own.txt"), "utf8")).toContain("staged own");
    await f.assertForeign();
  });

  it.each(["after push", "before merge"])("restores owned work on cancellation %s and keeps both stashes", async (when) => {
    const f = await fixture();
    const controller = new AbortController();
    const interleaved: GitExec = async (args, cwd, options) => {
      const result = await systemGit(args, cwd, options);
      if (args[0] === "stash" && args[1] === "push") {
        await f.pushForeign();
        if (when === "after push") controller.abort();
      }
      return result;
    };
    const result = await pullFastForward(interleaved, f.local, (phase) => {
      if (when === "before merge" && phase === "fast_forward") controller.abort();
    }, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.originalHead);
    await f.assertRestored();
    await f.assertForeign();
  });

  it.each(["after push", "before rollback"])("restores owned work on merge failure with a sibling push %s", async (when) => {
    const f = await fixture();
    const interleaved: GitExec = async (args, cwd, options) => {
      if (args[0] === "merge") {
        if (when === "before rollback") await f.pushForeign();
        return ok({ stdout: "", stderr: "simulated checkout failure", exitCode: 128 });
      }
      const result = await systemGit(args, cwd, options);
      if (when === "after push" && args[0] === "stash" && args[1] === "push") await f.pushForeign();
      return result;
    };
    const result = await pullFastForward(interleaved, f.local);
    expect(result).toMatchObject({ ok: false, error: { code: "merge_failed" } });
    expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.originalHead);
    await f.assertRestored();
    await f.assertForeign();
  });

  it("refuses duplicate ownership markers before merging or applying anything", async () => {
    const f = await fixture();
    let merged = false;
    const duplicate: GitExec = async (args, cwd, options) => {
      if (args[0] === "merge") merged = true;
      const result = await systemGit(args, cwd, options);
      if (args[0] === "stash" && args[1] === "push") {
        const sha = await git(cwd, "rev-parse", "refs/stash");
        const subject = await git(cwd, "log", "-1", "--format=%gs", "-g", "refs/stash");
        await f.pushForeign();
        await git(cwd, "stash", "store", "-m", subject, sha);
      }
      return result;
    };
    const result = await pullFastForward(duplicate, f.local);
    expect(result).toMatchObject({ ok: false, error: { code: "pull_stash_ownership", message: expect.stringContaining("more than once") } });
    expect(merged).toBe(false);
    expect(await git(f.local, "status", "--porcelain")).toBe("");
    expect((await git(f.local, "stash", "list", "--format=%H")).split("\n")).toHaveLength(3);
    await f.assertForeign();
  });

  it("refuses a missing ownership marker without applying the foreign top entry", async () => {
    const f = await fixture();
    let merged = false;
    const removed: GitExec = async (args, cwd, options) => {
      if (args[0] === "merge") merged = true;
      const result = await systemGit(args, cwd, options);
      if (args[0] === "stash" && args[1] === "push") {
        await git(cwd, "stash", "drop", "stash@{0}");
        await f.pushForeign();
      }
      return result;
    };
    const result = await pullFastForward(removed, f.local);
    expect(result).toMatchObject({ ok: false, error: { code: "pull_stash_ownership", message: expect.stringContaining("entry is missing") } });
    expect(merged).toBe(false);
    await f.assertForeign();
  });

  it("recovers an owned stash even when the push reports cancellation after saving it", async () => {
    const f = await fixture();
    const canceled: GitExec = async (args, cwd, options) => {
      const result = await systemGit(args, cwd, options);
      if (args[0] === "stash" && args[1] === "push") {
        await f.pushForeign();
        return err({ kind: "git", code: "aborted", message: "Git was stopped before it completed." });
      }
      return result;
    };
    const result = await pullFastForward(canceled, f.local);
    expect(result).toMatchObject({ ok: false, error: { code: "aborted", message: expect.stringContaining("Local changes restored") } });
    await f.assertRestored();
    await f.assertForeign();
  });

  it("finishes restoration with a fresh signal when cancellation arrives after the fast-forward", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const recovery = new AbortController();
    let finished: boolean | undefined;
    const checked: GitExec = (args, cwd, options) => {
      if (args[0] === "stash" && args[1] === "apply") expect(options?.signal).toBe(recovery.signal);
      return systemGit(args, cwd, options);
    };
    const result = await pullFastForward(checked, f.local, (phase) => {
      if (phase === "reapply") controller.abort();
    }, { signal: controller.signal, startRecovery: () => ({ signal: recovery.signal, finish: (succeeded) => { finished = succeeded; } }) });
    expect(result).toMatchObject({ ok: true, value: { reappliedWithConflicts: false, recoveryStash: expect.any(String) } });
    expect(finished).toBe(true);
    await f.assertRestored();
  });

  it.each([false, true])("reports failed restoration accurately after %s rollback", async (rollback) => {
    const f = await fixture();
    const failing: GitExec = async (args, cwd, options) => {
      if (args[0] === "merge" && rollback) {
        await f.pushForeign();
        return ok({ stdout: "", stderr: "simulated merge failure", exitCode: 128 });
      }
      if (args[0] === "stash" && args[1] === "apply") return ok({ stdout: "", stderr: "simulated apply failure", exitCode: 1 });
      const result = await systemGit(args, cwd, options);
      if (args[0] === "merge") await f.pushForeign();
      return result;
    };
    const result = await pullFastForward(failing, f.local);
    expect(result).toMatchObject({ ok: false, error: { code: "stash_reapply_failed", message: expect.stringContaining("Recovery stash kept in Stashes") } });
    if (!result.ok) expect(result.error.message).toContain("simulated apply failure");
    expect(await git(f.local, "status", "--porcelain")).toBe("");
    expect((await git(f.local, "stash", "list", "--format=%H")).split("\n")).toHaveLength(2);
    await f.assertForeign();
  });
});
