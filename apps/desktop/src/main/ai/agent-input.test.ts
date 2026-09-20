import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RebaseCommitRef } from "@pwrgit/shared";
import { createSystemGit } from "../git/test-support/system-git";
import {
  collectCommitsInput,
  collectStagedInput,
  exclusionFor,
  parseNumstat,
  splitPatch
} from "./agent-input";

const systemGit = createSystemGit();

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function repo(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "pwrgit-agent-input-")), "repo");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "user.email", "orig@x.com"]);
  git(dir, ["config", "user.name", "Orig"]);
  return dir;
}

function commit(dir: string, files: Record<string, string>, message: string): void {
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
}

function top(dir: string, n: number): RebaseCommitRef[] {
  return git(dir, ["log", "-n", String(n), "--format=%H%x1f%s"])
    .split("\n")
    .map((line) => {
      const [hash = "", subject = ""] = line.split("\x1f");
      return { hash, subject };
    });
}

const lines = (n: number, prefix: string): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n") + "\n";

describe("exclusionFor", () => {
  it.each([
    [".env", "never_send"],
    ["config/.env.production", "never_send"],
    ["deploy/secrets/token.txt", "never_send"],
    ["certs/server.pem", "never_send"],
    ["home/.ssh/id_ed25519", "never_send"],
    [".npmrc", "never_send"],
    ["pnpm-lock.yaml", "lockfile"],
    ["web/package-lock.json", "lockfile"],
    ["Cargo.lock", "lockfile"],
    ["src/__snapshots__/view.test.ts.snap", "snapshot"]
  ])("holds back %s as %s", (path, treatment) => {
    expect(exclusionFor(path, false)).toBe(treatment);
  });

  it.each([".env.example", "src/env.ts", "docs/secrets.md", "src/lock.ts"])(
    "sends %s",
    (path) => {
      expect(exclusionFor(path, false)).toBeNull();
    }
  );

  it("never sends a binary, and a secret outranks it", () => {
    expect(exclusionFor("logo.png", true)).toBe("binary");
    expect(exclusionFor("keys/prod.p12", true)).toBe("never_send");
  });

  // macOS and Windows resolve these to the same file as the lower-case
  // spelling, so a case-sensitive guard would send the same secret.
  it.each([".ENV", "home/.ssh/ID_RSA", "Deploy/Secrets/token.txt", "certs/server.PEM"])(
    "holds back %s whatever its case",
    (path) => {
      expect(exclusionFor(path, false)).toBe("never_send");
    }
  );
});

describe("patch parsing", () => {
  it("reads numstat, including binary rows and tabs in names", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\tlogo.png\n0\t2\tweird\tname\n")).toEqual([
      { path: "src/a.ts", added: 3, removed: 1, binary: false },
      { path: "logo.png", added: 0, removed: 0, binary: true },
      { path: "weird\tname", added: 0, removed: 2, binary: false }
    ]);
  });

  it("splits a patch by destination path", () => {
    const chunks = splitPatch(
      "diff --git a/one.ts b/one.ts\n+1\ndiff --git a/two.ts b/two.ts\n+2\n"
    );
    expect([...chunks.keys()]).toEqual(["one.ts", "two.ts"]);
    expect(chunks.get("two.ts")).toEqual(["diff --git a/two.ts b/two.ts", "+2", ""]);
  });

  it("keys a path that itself contains \" b/\" on the whole path", () => {
    const chunks = splitPatch("diff --git a/my b/dir/n.md b/my b/dir/n.md\n+1\n");
    expect([...chunks.keys()]).toEqual(["my b/dir/n.md"]);
  });
});

describe("collectCommitsInput (system git)", () => {
  it("sends diffs oldest first, holds back lockfiles and secrets, and lists them", async () => {
    const dir = repo();
    commit(dir, { "README.md": "hi\n" }, "chore: init");
    commit(
      dir,
      { "src/export.ts": "export const csv = 1;\n", "pnpm-lock.yaml": lines(50, "lock") },
      "feat(export): add exporter"
    );
    commit(dir, { "src/export.ts": "export const csv = 2;\n", ".env": "TOKEN=hunter2\n" }, "wip");

    const input = await collectCommitsInput(systemGit, dir, top(dir, 2));

    expect(input).not.toBeNull();
    expect(input!.commits.map((c) => c.subject)).toEqual(["feat(export): add exporter", "wip"]);
    const all = input!.commits.map((c) => c.diff).join("\n");
    expect(all).toContain("export const csv = 2;");
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("lock 3");
    const byPath = new Map(input!.manifest.files.map((f) => [f.path, f]));
    expect(byPath.get(".env")?.treatment).toBe("never_send");
    expect(byPath.get("pnpm-lock.yaml")?.treatment).toBe("lockfile");
    expect(byPath.get("src/export.ts")).toEqual(
      expect.objectContaining({ treatment: "sent", added: 2, removed: 1 })
    );
    expect(input!.manifest.commitCount).toBe(2);
    // The style sample comes from before the selection, not from it.
    expect(input!.styleSubjects).toEqual(["chore: init"]);
  });

  it("cuts a file at the budget and says how much was left out", async () => {
    const dir = repo();
    commit(dir, { "README.md": "hi\n" }, "init");
    commit(dir, { "big.txt": lines(300, "row") }, "big one");
    commit(dir, { "small.txt": "tiny\n" }, "small one");

    const input = await collectCommitsInput(systemGit, dir, top(dir, 2), 100);

    const big = input!.manifest.files.find((f) => f.path === "big.txt");
    expect(big?.treatment).toBe("cut");
    expect(big?.sentLines).toBe(100);
    expect(big!.totalLines).toBeGreaterThan(300);
    expect(input!.commits[0]!.diff).toMatch(/\[… \d+ more lines of big\.txt not sent\]/);
    // The budget is spent; the next file gets nothing, and is marked cut too.
    expect(input!.manifest.files.find((f) => f.path === "small.txt")?.sentLines).toBe(0);
    expect(input!.manifest.budget).toEqual({ used: 100, limit: 100 });
  });

  it("stops reading patches once the budget is spent", async () => {
    const dir = repo();
    commit(dir, { "README.md": "hi\n" }, "init");
    commit(dir, { "big.txt": lines(300, "row") }, "big one");
    for (let i = 0; i < 4; i++) commit(dir, { [`later-${i}.txt`]: "x\n" }, `later ${i}`);

    // A patch nobody can keep a line of is a git process spawned for nothing.
    let patches = 0;
    const counted: typeof systemGit = async (args, cwd) => {
      if (args.includes("--patch")) patches += 1;
      return systemGit(args, cwd);
    };

    const input = await collectCommitsInput(counted, dir, top(dir, 5), 20);

    expect(patches).toBe(1);
    expect(input!.manifest.budget.used).toBe(20);
    expect(
      input!.manifest.files.filter((file) => file.path.startsWith("later-"))
    ).toHaveLength(4);
    for (const file of input!.manifest.files.filter((f) => f.path.startsWith("later-"))) {
      expect(file).toEqual(expect.objectContaining({ treatment: "cut", sentLines: 0 }));
    }
  });

  it("learns a conventional-commit repository from its recent subjects", async () => {
    const dir = repo();
    for (const subject of ["feat: a", "fix(core): b", "chore: c", "docs: d", "feat(ui)!: e"]) {
      commit(dir, { [`${subject.length}-${Math.random()}.txt`]: subject }, subject);
    }
    commit(dir, { "x.txt": "1\n" }, "x");
    commit(dir, { "y.txt": "1\n" }, "y");

    const input = await collectCommitsInput(systemGit, dir, top(dir, 2));
    expect(input!.style).toEqual({ convention: "conventional", matched: 5, sampled: 5 });
  });
});

describe("collectStagedInput (system git)", () => {
  it("reads the index only, never the working tree", async () => {
    const dir = repo();
    commit(dir, { "a.ts": "one\n" }, "init");
    writeFileSync(join(dir, "a.ts"), "staged change\n");
    git(dir, ["add", "a.ts"]);
    writeFileSync(join(dir, "a.ts"), "unstaged change\n");
    writeFileSync(join(dir, "untracked.ts"), "never\n");

    const input = await collectStagedInput(systemGit, dir);

    expect(input!.diff).toContain("staged change");
    expect(input!.diff).not.toContain("unstaged change");
    expect(input!.diff).not.toContain("never");
    expect(input!.manifest.source).toBe("staged");
    expect(input!.manifest.files.map((f) => f.path)).toEqual(["a.ts"]);
  });
});
