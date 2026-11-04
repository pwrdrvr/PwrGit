import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitExec } from "./dugite";
import {
  fetchAllRemotes,
  fetchNamedRemote,
  fetchNamedRemotes,
  fetchRemote,
  listTagPage,
  pullFastForward
} from "./git-service";
import { readGraphTags } from "./graph-tags";
import { bulkSyncRepositories } from "./bulk-sync";
import { createSystemGit } from "./test-support/system-git";

const roots: string[] = [];
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const systemGit = createSystemGit({ env });

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    cwd: tmpdir(), env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

function fixture(annotated: boolean) {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-fetch-tags-"));
  roots.push(root);
  git(root, "init", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "origin.git", "publisher");
  const publisher = join(root, "publisher");
  git(publisher, "config", "user.name", "Tag Fixture");
  git(publisher, "config", "user.email", "tags@example.test");
  writeFileSync(join(publisher, "release.txt"), "original release\n");
  git(publisher, "add", ".");
  git(publisher, "commit", "-m", "Original release");
  const oldHead = git(publisher, "rev-parse", "HEAD");
  const tag = () => git(publisher, "tag", ...(annotated ? ["-a", "-m", "Release"] : []), "v1.2.3");
  tag();
  git(publisher, "push", "-u", "origin", "main", "--tags");
  git(root, "clone", "origin.git", "local");
  const local = join(root, "local");
  // The branch is already current when the tag is reissued. Neither the
  // checkout's HEAD nor its ahead/behind counts can signal this change.
  writeFileSync(join(publisher, "release.txt"), "reissued release\n");
  git(publisher, "commit", "-am", "Reissued release");
  git(publisher, "push", "origin", "main");
  git(local, "pull", "--ff-only");
  const newHead = git(local, "rev-parse", "HEAD");
  git(publisher, "push", "origin", ":refs/tags/v1.2.3");
  git(publisher, "tag", "-d", "v1.2.3");
  tag();
  git(publisher, "push", "origin", "refs/tags/v1.2.3");
  git(local, "tag", "local-only", oldHead);
  return { root, local, oldHead, newHead };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("refreshing a reissued remote tag", () => {
  const operations = [
    { name: "Fetch", run: (git: GitExec, cwd: string) => fetchRemote(git, cwd) },
    { name: "named Fetch", run: (git: GitExec, cwd: string) => fetchNamedRemote(git, cwd, "origin") },
    { name: "multiple-remotes Fetch", run: (git: GitExec, cwd: string) => fetchNamedRemotes(git, cwd, ["origin"]) },
    { name: "Fetch all", run: (git: GitExec, cwd: string) => fetchAllRemotes(git, cwd) },
    { name: "Pull", run: (git: GitExec, cwd: string) => pullFastForward(git, cwd) }
  ];
  for (const annotated of [false, true]) {
    it.each(operations)(`$name refreshes ${annotated ? "an annotated" : "a lightweight"} tag with an up-to-date branch`, async ({ run }) => {
      const { local, oldHead, newHead } = fixture(annotated);
      expect(git(local, "rev-parse", "v1.2.3^{}")).toBe(oldHead);
      const result = await run(systemGit, local);
      expect(result.ok).toBe(true);
      expect(git(local, "rev-parse", "v1.2.3^{}")).toBe(newHead);
      expect(git(local, "rev-parse", "local-only")).toBe(oldHead);
      expect(git(local, "rev-parse", "HEAD")).toBe(newHead);
      // Assert both visible consumers against Git, not just the ref itself.
      const page = await listTagPage(systemGit, local);
      expect(page.ok && page.value.rows.find((tag) => tag.name === "v1.2.3")?.targetId).toBe(newHead);
      const graph = await readGraphTags(systemGit, local);
      expect(graph.ok && graph.value[newHead]?.name).toBe("v1.2.3");
      expect(graph.ok && graph.value[oldHead]).toBeUndefined();
    });
  }

  it("refreshes tags during bulk sync without moving an up-to-date checkout", async () => {
    const { local, newHead } = fixture(true);
    const result = await bulkSyncRepositories(systemGit, [
      { id: "repo", name: "Tag fixture", path: local, worktrees: [{ id: "main", branch: "main", path: local }] }
    ], { operationId: "tags", mode: "fetch" });
    expect(result.counts.remotes.fetched).toBe(1);
    expect(git(local, "rev-parse", "v1.2.3^{}")).toBe(newHead);
  });

  it("uses one fetch and no extra ref advertisement or object transfer with 20,000 unchanged tags", async () => {
    const { root, local, oldHead, newHead } = fixture(false);
    git(local, "fetch", "--tags", "--force");
    git(local, "pack-refs", "--all");
    const refs = Array.from({ length: 20_000 }, (_, index) =>
      `${oldHead} refs/tags/archive-${String(index).padStart(5, "0")}`
    );
    // Seed packed lightweight refs directly so Windows CI does not spend
    // most of this protocol test creating and deleting 40,000 loose files.
    writeFileSync(join(root, "origin.git", "packed-refs"), `${refs.join("\n")}\n`);
    const packed = join(local, ".git", "packed-refs");
    const localRefs = readFileSync(packed, "utf8").split("\n").filter((line) => line !== "" && !line.startsWith("#"));
    writeFileSync(packed, [...localRefs, ...refs].sort((a, b) =>
      a.slice(41) < b.slice(41) ? -1 : a.slice(41) > b.slice(41) ? 1 : 0
    ).join("\n") + "\n");
    expect(git(local, "rev-parse", "v1.2.3")).toBe(newHead);

    const traces: string[] = [];
    const calls: string[][] = [];
    const tracedGit: GitExec = async (args, cwd, options) => {
      calls.push(args);
      const result = await systemGit(args, cwd, {
        ...options, env: { ...options?.env, GIT_TRACE_PACKET: "1" }
      });
      if (result.ok) traces.push(result.value.stderr);
      return result;
    };
    // Compare the old fetch with the product operation on the same no-op
    // fixture. Packet tracing checks the protocol, not a wall-clock limit.
    const baseline = await tracedGit(["fetch", "--prune"], local);
    expect(baseline.ok && baseline.value.exitCode).toBe(0);
    calls.length = 0;
    expect((await fetchRemote(tracedGit, local)).ok).toBe(true);
    expect(calls).toHaveLength(1);
    const advertisements = (trace: string) =>
      trace.match(/fetch< [a-f0-9]+ refs\/tags\//g)?.length ?? 0;
    expect(advertisements(traces[0]!)).toBe(20_001);
    expect(advertisements(traces[1]!)).toBe(advertisements(traces[0]!));
    for (const trace of traces) {
      expect(trace).not.toMatch(/fetch> want /);
      expect(trace.match(/fetch> command=ls-refs/g)).toHaveLength(1);
    }
  }, 30_000);
});
