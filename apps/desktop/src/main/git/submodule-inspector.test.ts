import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { err, ok } from "@pwrgit/shared";
import {
  execGitRecords,
  type GitExec,
  type GitOutput,
  type GitRecordExec
} from "./dugite";
import {
  inspectSubmodules,
  parseCheckoutStatus,
  parseHeadGitlinks,
  parseIndexGitlinks,
  parseSubmoduleConfig,
  SUBMODULE_DEPTH_LIMIT
} from "./submodule-inspector";

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "PwrGit Test",
  GIT_AUTHOR_EMAIL: "test@pwrgit.dev",
  GIT_COMMITTER_NAME: "PwrGit Test",
  GIT_COMMITTER_EMAIL: "test@pwrgit.dev",
  GIT_ALLOW_PROTOCOL: "file"
};

const systemGit: GitExec = (args, cwd, options) =>
  new Promise((resolveResult) => {
    const proc = spawn("git", args, {
      cwd,
      env: { ...GIT_ENV, ...options?.env }
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", (cause) =>
      resolveResult(
        err({ kind: "git", code: "spawn_failed", message: cause.message })
      )
    );
    proc.on("close", (exitCode) =>
      resolveResult(
        ok({
          stdout,
          stderr,
          exitCode: exitCode ?? 1
        } satisfies GitOutput)
      )
    );
  });

const systemGitRecords: GitRecordExec = (args, cwd, options) =>
  execGitRecords(args, cwd, {
    ...options,
    env: { ...GIT_ENV, ...options.env }
  });

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8"
  }).trim();
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);
  git(path, ["config", "user.name", "PwrGit Test"]);
  git(path, ["config", "user.email", "test@pwrgit.dev"]);
  git(path, ["config", "core.autocrlf", "false"]);
}

function commitFile(repo: string, file: string, content: string, message: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, ["add", "--", file]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function addSubmodule(
  parent: string,
  child: string,
  path: string,
  name?: string
): void {
  const args = ["-c", "protocol.file.allow=always", "submodule", "add"];
  if (name !== undefined) args.push("--name", name);
  args.push(child, path);
  git(parent, args);
}

function commitAll(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function expectSnapshot(
  result: Awaited<ReturnType<typeof inspectSubmodules>>
) {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("submodule output parsers", () => {
  it("keeps NUL-delimited paths and index conflict stages exact", () => {
    const commit = "a".repeat(40);
    expect(
      parseHeadGitlinks(`160000 commit ${commit}\tmodules/line\nbreak\0`)
    ).toEqual([{ path: "modules/line\nbreak", commit }]);
    expect(
      parseIndexGitlinks(
        `160000 ${commit} 2\tmodules/with space\0` +
          `100644 ${"b".repeat(40)} 0\tordinary.txt\0`
      )
    ).toEqual([{ path: "modules/with space", commit, stage: 2 }]);
  });

  it("parses dotted section names and separates checkout dirtiness", () => {
    expect(
      parseSubmoduleConfig(
        [
          "submodule.vendor.core.path\nmodules/core",
          "submodule.vendor.core.url\n../core.git",
          "submodule.vendor.core.branch\nrelease/2"
        ].join("\0") + "\0"
      )
    ).toEqual([
      {
        name: "vendor.core",
        path: "modules/core",
        url: "../core.git",
        branch: "release/2"
      }
    ]);
    expect(
      parseCheckoutStatus(
        `# branch.oid ${"c".repeat(40)}\0# branch.head (detached)\0? dirty.txt\0`
      )
    ).toEqual({
      commit: "c".repeat(40),
      detached: true,
      dirty: true
    });
  });
});

describe("inspectSubmodules (system git)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-submodules-"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("uses the parent gitlink as the pin while surfacing tag, branch hint, detached checkout, dirtiness, and divergence", async () => {
    const child = join(root, "child");
    const parent = join(root, "parent");
    initRepo(child);
    const pinned = commitFile(child, "api.txt", "v1\n", "version one");
    git(child, ["tag", "v1.0.0", pinned]);
    const newer = commitFile(child, "api.txt", "v2\n", "version two");
    initRepo(parent);
    commitFile(parent, "README.md", "parent\n", "parent baseline");

    addSubmodule(parent, child, "modules/api", "api.module");
    git(join(parent, "modules/api"), ["checkout", "--detach", pinned]);
    git(parent, [
      "config",
      "--file",
      ".gitmodules",
      "submodule.api.module.branch",
      "release/1"
    ]);
    commitAll(parent, "pin api v1");

    // `.gitmodules` says release/1, but the parent still records the v1
    // gitlink. Move the child to a newer detached commit and dirty it.
    git(join(parent, "modules/api"), ["checkout", "--detach", newer]);
    writeFileSync(join(parent, "modules/api", "scratch.txt"), "dirty\n");

    const snapshot = expectSnapshot(
      await inspectSubmodules(systemGit, systemGitRecords, parent)
    );
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.submodules).toHaveLength(1);
    expect(snapshot.submodules[0]).toMatchObject({
      name: "api.module",
      path: "modules/api",
      pinnedCommit: pinned,
      indexCommit: pinned,
      checkedOutCommit: newer,
      checkoutState: "checked_out",
      relation: "ahead_of_pin",
      dirty: true,
      detached: true,
      pinnedTags: ["v1.0.0"],
      configuredBranch: "release/1",
      configuredUrl: child,
      initializedUrl: child
    });
    // Ground truth: this is the object Git commits in the parent tree.
    expect(git(parent, ["rev-parse", "HEAD:modules/api"])).toBe(pinned);
  });

  it("isolates multiple and nested checkouts plus missing, uninitialized, deinitialized, and changed-URL failures", async () => {
    const leaf = join(root, "leaf");
    const outer = join(root, "outer");
    const plain = join(root, "plain");
    const parent = join(root, "parent");
    for (const repo of [leaf, outer, plain, parent]) initRepo(repo);
    commitFile(leaf, "leaf.txt", "leaf\n", "leaf");
    commitFile(plain, "plain.txt", "plain\n", "plain");
    commitFile(outer, "outer.txt", "outer\n", "outer");
    addSubmodule(outer, leaf, "deps/leaf");
    commitAll(outer, "add nested leaf");
    commitFile(parent, "README.md", "parent\n", "parent");

    addSubmodule(parent, outer, "modules/outer");
    addSubmodule(parent, plain, "modules/missing");
    addSubmodule(parent, plain, "modules/uninitialized");
    addSubmodule(parent, plain, "modules/deinitialized");
    commitAll(parent, "add submodules");
    git(join(parent, "modules/outer"), [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--recursive"
    ]);

    // Changed declaration: local config still names the reviewed URL used at
    // initialization, while `.gitmodules` now points somewhere else.
    const movedUrl = join(root, "moved-outer.git");
    git(parent, [
      "config",
      "--file",
      ".gitmodules",
      "submodule.modules/outer.url",
      movedUrl
    ]);

    // Deinit retains `.git/modules/...`; a fresh uninitialized clone has no
    // retained child repository. Missing removes the checkout path entirely.
    git(parent, ["submodule", "deinit", "-f", "modules/deinitialized"]);
    git(parent, ["submodule", "deinit", "-f", "modules/uninitialized"]);
    const uninitializedGitDir = resolve(
      parent,
      git(parent, [
        "rev-parse",
        "--git-path",
        "modules/modules/uninitialized"
      ])
    );
    rmSync(uninitializedGitDir, { recursive: true, force: true });
    rmSync(join(parent, "modules/missing"), { recursive: true, force: true });

    const snapshot = expectSnapshot(
      await inspectSubmodules(systemGit, systemGitRecords, parent)
    );
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.submodules.map((row) => row.path)).toEqual([
      "modules/deinitialized",
      "modules/missing",
      "modules/outer",
      "modules/outer/deps/leaf",
      "modules/uninitialized"
    ]);

    const byPath = new Map(snapshot.submodules.map((row) => [row.path, row]));
    expect(byPath.get("modules/deinitialized")).toMatchObject({
      checkoutState: "deinitialized",
      dirty: null
    });
    expect(byPath.get("modules/missing")).toMatchObject({
      checkoutState: "missing"
    });
    expect(byPath.get("modules/uninitialized")).toMatchObject({
      checkoutState: "uninitialized"
    });
    expect(byPath.get("modules/outer")).toMatchObject({
      checkoutState: "checked_out",
      configuredUrl: movedUrl,
      initializedUrl: outer
    });
    expect(byPath.get("modules/outer")?.issues.map((problem) => problem.code)).toContain(
      "url_changed"
    );
    expect(byPath.get("modules/outer/deps/leaf")).toMatchObject({
      depth: 1,
      checkoutState: "checked_out",
      relation: "at_pin"
    });
  });

  it("finds retained submodule data in a linked worktree's Git directory", async () => {
    const child = join(root, "linked-child");
    const parent = join(root, "primary");
    const linked = join(root, "linked");
    initRepo(child);
    const childCommit = commitFile(child, "child.txt", "child\n", "child");
    initRepo(parent);
    commitFile(parent, "README.md", "parent\n", "parent");
    writeFileSync(
      join(parent, ".gitmodules"),
      `[submodule "modules/child"]\n\tpath = modules/child\n\turl = ${child.replaceAll("\\", "/")}\n`
    );
    git(parent, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${childCommit},modules/child`
    ]);
    git(parent, ["add", ".gitmodules"]);
    git(parent, ["commit", "-m", "record child"]);
    git(parent, ["worktree", "add", "-b", "linked-audit", linked]);
    git(linked, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "modules/child"
    ]);
    git(linked, ["submodule", "deinit", "-f", "modules/child"]);

    const retainedPath = resolve(
      linked,
      git(linked, [
        "rev-parse",
        "--git-path",
        "modules/modules/child"
      ])
    );
    expect(retainedPath).toContain("worktrees");

    const snapshot = expectSnapshot(
      await inspectSubmodules(systemGit, systemGitRecords, linked)
    );
    expect(snapshot.submodules[0]).toMatchObject({
      path: "modules/child",
      checkoutState: "deinitialized"
    });
  });

  it("marks a checked-out nested chain beyond the depth limit as truncated", async () => {
    const parent = join(root, "deep-parent");
    let current = parent;
    for (let depth = 0; depth <= SUBMODULE_DEPTH_LIMIT + 1; depth += 1) {
      mkdirSync(current, { recursive: true });
      writeFileSync(join(current, ".gitmodules"), "nested\n");
      current = join(current, "next");
    }
    const commit = "d".repeat(40);
    const recordGit: GitRecordExec = async (args) => {
      if (args[0] === "ls-files") {
        return ok({
          records: [`160000 ${commit} 0\tnext`],
          stderr: "",
          exitCode: 0,
          truncated: false
        });
      }
      if (args[0] === "ls-tree") {
        return ok({
          records: [`160000 commit ${commit}\tnext`],
          stderr: "",
          exitCode: 0,
          truncated: false
        });
      }
      if (args.includes("--file")) {
        return ok({
          records: [
            "submodule.next.path\nnext",
            "submodule.next.url\n../next.git"
          ],
          stderr: "",
          exitCode: 0,
          truncated: false
        });
      }
      return ok({
        records: [],
        stderr: "",
        exitCode: 1,
        truncated: false
      });
    };
    const gitExec: GitExec = async (args) => {
      if (args[0] === "status") {
        return ok({
          stdout: `# branch.oid ${commit}\0# branch.head main\0`,
          stderr: "",
          exitCode: 0
        });
      }
      if (args[0] === "rev-parse") {
        return ok({ stdout: ".git/modules\n", stderr: "", exitCode: 0 });
      }
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    };

    const snapshot = expectSnapshot(
      await inspectSubmodules(gitExec, recordGit, parent)
    );
    expect(snapshot.submodules).toHaveLength(SUBMODULE_DEPTH_LIMIT + 1);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.issues.map((problem) => problem.code)).toContain(
      "scan_truncated"
    );
  });

  it("classifies staged pins, behind checkouts, and histories that diverged from the pin", async () => {
    const child = join(root, "history");
    const parent = join(root, "parent");
    initRepo(child);
    const base = commitFile(child, "history.txt", "base\n", "base");
    const tip = commitFile(child, "history.txt", "tip\n", "tip");
    initRepo(parent);
    commitFile(parent, "README.md", "parent\n", "parent");
    addSubmodule(parent, child, "modules/staged");
    addSubmodule(parent, child, "modules/behind");
    addSubmodule(parent, child, "modules/diverged");

    for (const path of ["modules/staged", "modules/behind", "modules/diverged"]) {
      git(join(parent, path), ["checkout", "--detach", base]);
    }
    commitAll(parent, "pin base");

    // The staged gitlink is the checkout expectation even though HEAD still
    // records base.
    git(join(parent, "modules/staged"), ["checkout", "--detach", tip]);
    git(parent, ["add", "--", "modules/staged"]);

    // Parent index still expects base here; create a checkout one commit
    // behind by pinning tip in HEAD first, then moving the child back.
    git(join(parent, "modules/behind"), ["checkout", "--detach", tip]);
    git(parent, ["add", "--", "modules/behind"]);
    git(parent, ["commit", "-m", "advance behind pin", "--", "modules/behind"]);
    git(join(parent, "modules/behind"), ["checkout", "--detach", base]);

    // Alternate history forked from base: neither side contains the other.
    const divergedCheckout = join(parent, "modules/diverged");
    git(divergedCheckout, ["checkout", "--detach", base]);
    commitFile(divergedCheckout, "fork.txt", "fork\n", "fork");

    const snapshot = expectSnapshot(
      await inspectSubmodules(systemGit, systemGitRecords, parent)
    );
    const byPath = new Map(snapshot.submodules.map((row) => [row.path, row]));
    expect(byPath.get("modules/staged")).toMatchObject({
      pinnedCommit: base,
      indexCommit: tip,
      checkedOutCommit: tip,
      relation: "at_pin"
    });
    expect(byPath.get("modules/behind")).toMatchObject({
      pinnedCommit: tip,
      checkedOutCommit: base,
      relation: "behind_pin"
    });
    expect(byPath.get("modules/diverged")).toMatchObject({
      pinnedCommit: base,
      relation: "ahead_of_pin"
    });

    // Re-pin diverged to tip without changing its alternate checkout.
    git(parent, ["update-index", "--cacheinfo", "160000", tip, "modules/diverged"]);
    const divergedSnapshot = expectSnapshot(
      await inspectSubmodules(systemGit, systemGitRecords, parent)
    );
    expect(
      divergedSnapshot.submodules.find((row) => row.path === "modules/diverged")
    ).toMatchObject({
      pinnedCommit: base,
      indexCommit: tip,
      relation: "diverged_from_pin"
    });
  });

  it(
    "keeps a stress-shaped parent with twenty child repositories bounded and deterministic",
    async () => {
      const child = join(root, "shared-child");
      const parent = join(root, "parent");
      initRepo(child);
      const childCommit = commitFile(child, "child.txt", "child\n", "child");
      initRepo(parent);
      commitFile(parent, "README.md", "parent\n", "parent");
      mkdirSync(join(parent, "modules"));
      const gitmodules: string[] = [];
      const indexArgs = ["update-index", "--add"];
      const childUrl = child.replaceAll("\\", "/");
      expect(childUrl).not.toContain("\\");
      for (let index = 0; index < 20; index += 1) {
        const path = `modules/child-${index.toString().padStart(2, "0")}`;
        // One small repository copied into twenty independent checkout paths:
        // a fast deterministic stress simulation without twenty clone/setup
        // subprocesses competing with the rest of the suite.
        cpSync(child, join(parent, ...path.split("/")), { recursive: true });
        gitmodules.push(
          `[submodule "${path}"]`,
          `\tpath = ${path}`,
          `\turl = ${childUrl}`
        );
        indexArgs.push("--cacheinfo", `160000,${childCommit},${path}`);
      }
      writeFileSync(join(parent, ".gitmodules"), `${gitmodules.join("\n")}\n`);
      git(parent, indexArgs);
      git(parent, ["add", ".gitmodules"]);
      git(parent, ["commit", "-m", "add twenty children"]);

      const snapshot = expectSnapshot(
        await inspectSubmodules(systemGit, systemGitRecords, parent)
      );
      expect(snapshot.truncated).toBe(false);
      expect(snapshot.issues).toEqual([]);
      expect(snapshot.submodules).toHaveLength(20);
      expect(snapshot.submodules[0]?.path).toBe("modules/child-00");
      expect(snapshot.submodules[19]?.path).toBe("modules/child-19");
      expect(
        snapshot.submodules.every(
          (row) =>
            row.checkoutState === "checked_out" &&
            row.relation === "at_pin" &&
            row.dirty === false
        )
      ).toBe(true);
    },
    60_000
  );
});
