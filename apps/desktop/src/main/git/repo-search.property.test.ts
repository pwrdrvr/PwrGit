import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  REPO_SEARCH_DEPTH,
  initiallyChecked,
  repositoriesInFolders,
  type RepoSearchResult
} from "@pwrgit/shared";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "./repo-indexer";
import { searchHomeForRepositories } from "./repo-search";
import { createSystemGit } from "./test-support/system-git";

// The rules of Find my repositories (design/New User Journey - UX Review,
// card 2e), held against generated home folders built with real Git:
//
// 1. No proposed folder lies inside a repository, and home is never proposed.
// 2. No directory inside a checkout is ever listed: the search stops at the
//    first `.git`, so a worktree or clone kept inside a repository
//    (`repo/.claude/worktrees/x`, `repo/libs/y`) is never reached or counted.
// 3. The repository count for any set of checked folders equals what the
//    real scan (`rescanProfile`) indexes once those folders are added.
//
// The oracle for 1 and 2 is this test's own record of what it put on disk;
// for 3 it is the profile scan itself, running Git.

const systemGit = createSystemGit();
const scratch = mkdtempSync(join(tmpdir(), "pwrgit-repo-search-"));
let seed = "";
let runNo = 0;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function configure(dir: string): void {
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "Tester"]);
  // A detached auto-maintenance can hold `.git/objects` mid-copy.
  git(dir, ["config", "maintenance.auto", "false"]);
  git(dir, ["config", "gc.auto", "0"]);
}

beforeAll(() => {
  seed = join(scratch, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]);
  configure(seed);
  writeFileSync(join(seed, "README.md"), "# seed\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "init"]);
});

// Folder names a home folder holds. Hidden and skipped names are in the mix
// on purpose: a repository there must be unreachable to both walks alike.
const SEGMENTS = ["code", "github", "acme", "work", "trees", "x", ".hidden", "node_modules", "Documents"];
const segmentArb = fc.constantFrom(...SEGMENTS);
const pathArb = (maxDepth: number, minLength = 1) =>
  fc.array(segmentArb, { minLength, maxLength: maxDepth });

type Op =
  | { kind: "repo"; at: string[] }
  | { kind: "worktree"; of: number; at: string[]; inside: false | "agent" | "plain" }
  | { kind: "nested"; of: number; name: string }
  | { kind: "bare"; at: string[]; layout: "dot-bare" | "named" }
  | { kind: "submodule"; at: string[] }
  | { kind: "remove"; of: number }
  | { kind: "plain"; at: string[] };

const opArb = (maxDepth: number): fc.Arbitrary<Op> =>
  fc.oneof(
    // A repository directly under home is the case where a nested checkout
    // still lies within the search's depth, so it is drawn often.
    {
      arbitrary: fc.record({
        kind: fc.constant("repo" as const),
        at: fc.oneof(fc.constant([] as string[]), pathArb(maxDepth))
      }),
      weight: 5
    },
    {
      arbitrary: fc.record({
        kind: fc.constant("worktree" as const),
        of: fc.nat(9),
        at: pathArb(maxDepth),
        // Inside the repository: an agent's hidden `.claude/worktrees`, or
        // a plain folder the walk would otherwise open.
        inside: fc.constantFrom(false as const, "agent" as const, "plain" as const)
      }),
      weight: 3
    },
    {
      arbitrary: fc.record({
        kind: fc.constant("nested" as const),
        of: fc.nat(9),
        name: fc.constantFrom("libs", "deps", "sub")
      }),
      weight: 1
    },
    {
      arbitrary: fc.record({
        kind: fc.constant("bare" as const),
        at: pathArb(Math.min(2, maxDepth)),
        layout: fc.constantFrom("dot-bare" as const, "named" as const)
      }),
      weight: 1
    },
    { arbitrary: fc.record({ kind: fc.constant("submodule" as const), at: pathArb(2) }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("remove" as const), of: fc.nat(9) }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("plain" as const), at: pathArb(maxDepth) }), weight: 1 }
  );

type Built = {
  home: string;
  /** Every folder that holds a `.git` entry (repositories, worktrees,
   *  submodules, nested clones) other than home itself. */
  checkouts: string[];
  /** Checkouts made inside another checkout. */
  nested: string[];
};

function isStrictlyInside(path: string, folder: string): boolean {
  return path !== folder && path.startsWith(folder + sep);
}

function build(ops: Op[], homeIsRepository: boolean): Built {
  runNo += 1;
  const home = realpathSync(mkdtempSync(join(scratch, `home-${runNo}-`)));
  const checkouts: string[] = [];
  const primaries: string[] = [];
  const nested: string[] = [];
  let made = 0;
  if (homeIsRepository) {
    git(home, ["init", "-q", "-b", "main"]);
    configure(home);
    writeFileSync(join(home, ".profile"), "export X=1\n");
    git(home, ["add", ".profile"]);
    git(home, ["commit", "-q", "-m", "dotfiles"]);
  }
  const free = (dir: string): boolean =>
    !existsSync(dir) &&
    // A checkout made above an existing one would turn it into a nested
    // clone after the fact; the `nested` op makes that shape on purpose.
    !checkouts.some((c) => isStrictlyInside(c, dir));
  const inside = (dir: string) => checkouts.some((c) => isStrictlyInside(dir, c));

  for (const op of ops) {
    made += 1;
    switch (op.kind) {
      case "repo": {
        const dir = join(home, ...op.at, `r${made}`);
        if (!free(dir) || inside(dir)) break;
        mkdirSync(join(dir, ".."), { recursive: true });
        cpSync(seed, dir, { recursive: true });
        checkouts.push(dir);
        primaries.push(dir);
        break;
      }
      case "worktree": {
        const of = primaries.filter(existsSync)[op.of % Math.max(1, primaries.length)];
        if (of === undefined || !existsSync(of)) break;
        const dir =
          op.inside === "agent"
            ? join(of, ".claude", "worktrees", `w${made}`)
            : op.inside === "plain"
              ? join(of, "wt", `w${made}`)
              : join(home, ...op.at, `w${made}`);
        if (!free(dir) || (!op.inside && inside(dir))) break;
        mkdirSync(join(dir, ".."), { recursive: true });
        git(of, ["worktree", "add", "-q", "-b", `w${made}`, dir]);
        checkouts.push(dir);
        if (op.inside) nested.push(dir);
        break;
      }
      case "nested": {
        const of = primaries.filter(existsSync)[op.of % Math.max(1, primaries.length)];
        if (of === undefined) break;
        const dir = join(of, op.name, `n${made}`);
        if (!free(dir)) break;
        mkdirSync(join(dir, ".."), { recursive: true });
        cpSync(seed, dir, { recursive: true });
        checkouts.push(dir);
        nested.push(dir);
        break;
      }
      case "bare": {
        // proj/.bare + proj/main: the layout the scan drops (card 2e). Or a
        // bare `proj.git` with its worktree beside it.
        const proj = join(home, ...op.at, `b${made}`);
        if (!free(proj) || inside(proj)) break;
        mkdirSync(proj, { recursive: true });
        const bare = op.layout === "dot-bare" ? ".bare" : `b${made}.git`;
        git(proj, ["clone", "-q", "--bare", seed, bare]);
        const main = join(proj, "main");
        git(join(proj, bare), ["worktree", "add", "-q", "-b", `b${made}`, main]);
        checkouts.push(main);
        break;
      }
      case "submodule": {
        if (!homeIsRepository) break;
        const rel = [...op.at, `s${made}`].join("/");
        const dir = join(home, ...op.at, `s${made}`);
        if (!free(dir) || inside(dir)) break;
        git(home, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", seed, rel]);
        checkouts.push(dir);
        break;
      }
      case "remove": {
        // A repository deleted out from under its linked worktrees.
        const of = primaries[op.of % Math.max(1, primaries.length)];
        if (of === undefined || !existsSync(of)) break;
        rmSync(of, { recursive: true, force: true });
        for (let i = checkouts.length - 1; i >= 0; i -= 1) {
          if (checkouts[i] === of || isStrictlyInside(checkouts[i]!, of)) checkouts.splice(i, 1);
        }
        break;
      }
      case "plain": {
        const dir = join(home, ...op.at, `p${made}`);
        if (!inside(dir)) mkdirSync(dir, { recursive: true });
        break;
      }
    }
  }
  return { home, checkouts, nested };
}

async function search(home: string, includeProtected: boolean): Promise<RepoSearchResult> {
  return searchHomeForRepositories({
    home,
    platform: process.platform,
    includeProtected,
    yieldToEventLoop: () => Promise.resolve()
  });
}

async function indexedCount(roots: string[]): Promise<number> {
  const db = openDatabase(":memory:");
  try {
    const profile = new ProfileService(db).create({
      name: "Search",
      email: "s@example.com",
      roots
    });
    const indexer = new RepoIndexer(db, systemGit);
    await indexer.rescanProfile(profile);
    return indexer.listRepos(profile.id).length;
  } finally {
    db.close();
  }
}

function assertNeverInside(built: Built, result: RepoSearchResult): void {
  for (const folder of result.folders) {
    // 1. No proposed folder lies inside a repository; home is never one.
    expect(folder.path).not.toBe(built.home);
    for (const c of built.checkouts) {
      expect(
        isStrictlyInside(folder.path, c),
        `${folder.path} is proposed inside the checkout ${c}`
      ).toBe(false);
    }
    // 2. Nothing inside a checkout is listed.
    for (const repo of folder.repositories) {
      for (const listed of repo.checkouts) {
        expect(built.nested, `${listed} lies inside a repository`).not.toContain(listed);
        for (const c of built.checkouts) {
          expect(
            isStrictlyInside(listed, c),
            `${listed} is listed from inside ${c}`
          ).toBe(false);
        }
      }
    }
  }
}

describe("Find my repositories", () => {
  it("never proposes or lists anything inside a repository, and counts what the scan indexes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb(REPO_SEARCH_DEPTH - 1), { minLength: 1, maxLength: 7 }),
        fc.boolean(),
        fc.boolean(),
        fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
        async (ops, homeIsRepository, includeProtected, picks) => {
          const built = build(ops, homeIsRepository);
          const result = await search(built.home, includeProtected);
          assertNeverInside(built, result);
          expect(result.homeIsRepository).toBe(homeIsRepository);

          // 3. Any set of checked folders: the count is what the scan indexes.
          // Every checkout sits within the search's depth here, so the scan
          // (five levels from each folder) can find nothing the search missed.
          const selectable = result.folders.filter((f) => f.selectable);
          const checked = new Set(
            selectable.filter((_, i) => picks[i % picks.length]).map((f) => f.path)
          );
          expect(await indexedCount([...checked])).toBe(
            repositoriesInFolders(result.folders, checked)
          );
          // And the list as it opens, checked by default.
          const defaults = initiallyChecked(result.folders);
          expect(await indexedCount([...defaults])).toBe(
            repositoriesInFolders(result.folders, defaults)
          );
        }
      ),
      { numRuns: 25 }
    );
  }, 120_000);

  it("past its depth it promises no more than the scan finds", async () => {
    // A checkout four levels down is beyond the search but within the scan's
    // five levels from a proposed folder: the sidebar may show more than the
    // count, never fewer.
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb(REPO_SEARCH_DEPTH + 1), { minLength: 1, maxLength: 6 }),
        async (ops) => {
          const built = build(ops, false);
          const result = await search(built.home, true);
          assertNeverInside(built, result);
          const defaults = initiallyChecked(result.folders);
          expect(await indexedCount([...defaults])).toBeGreaterThanOrEqual(
            repositoriesInFolders(result.folders, defaults)
          );
        }
      ),
      { numRuns: 8 }
    );
  }, 120_000);
});

describe("Find my repositories, the cases on card 2e", () => {
  it("never reaches a worktree or clone kept inside a repository", async () => {
    // Harold's case: an agent's worktrees and a vendored clone inside a
    // repository directly under home, all within three levels.
    const built = build(
      [
        { kind: "repo", at: [] },
        { kind: "worktree", of: 0, at: [], inside: "agent" },
        { kind: "worktree", of: 0, at: [], inside: "plain" },
        { kind: "nested", of: 0, name: "libs" }
      ],
      false
    );
    const result = await search(built.home, false);
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0]!.isRepository).toBe(true);
    expect(result.folders[0]!.repositories.map((r) => r.checkouts)).toEqual([
      [result.folders[0]!.path]
    ]);
    assertNeverInside(built, result);
  });

  it("folds a worktree outside its repository into it, unchecked when the repository was found", async () => {
    const built = build(
      [
        { kind: "repo", at: ["code"] },
        { kind: "worktree", of: 0, at: ["trees"], inside: false },
        { kind: "worktree", of: 0, at: ["code"], inside: "agent" }
      ],
      false
    );
    const result = await search(built.home, false);
    const code = result.folders.find((f) => f.path === join(built.home, "code"))!;
    const trees = result.folders.find((f) => f.path === join(built.home, "trees"))!;
    expect(code.checked).toBe(true);
    expect(code.repositories).toHaveLength(1);
    expect(trees.checked).toBe(false);
    expect(trees.note).toEqual({ kind: "worktrees-of", repositoryFolders: [code.path] });
    expect(repositoriesInFolders(result.folders, new Set([code.path, trees.path]))).toBe(1);
  });

  it("proposes, checked, a worktree whose repository it could not reach", async () => {
    const built = build(
      [
        { kind: "repo", at: [".hidden"] },
        { kind: "worktree", of: 0, at: ["trees"], inside: false }
      ],
      false
    );
    const result = await search(built.home, false);
    expect(result.folders.map((f) => [relative(built.home, f.path), f.checked])).toEqual([["trees", true]]);
    expect(await indexedCount([join(built.home, "trees")])).toBe(1);
  });

  it("leaves out a worktree whose repository is gone", async () => {
    const built = build(
      [
        { kind: "repo", at: ["code"] },
        { kind: "worktree", of: 0, at: ["trees"], inside: false },
        { kind: "remove", of: 0 }
      ],
      false
    );
    const result = await search(built.home, false);
    expect(result.folders).toEqual([]);
  });

  it("does not stop at the home folder's own .git, and shows its submodules unchecked", async () => {
    const built = build(
      [
        { kind: "repo", at: ["code"] },
        { kind: "submodule", at: ["libs"] }
      ],
      true
    );
    const result = await search(built.home, false);
    expect(result.homeIsRepository).toBe(true);
    const libs = result.folders.find((f) => f.path === join(built.home, "libs"))!;
    expect(libs.checked).toBe(false);
    expect(libs.note).toEqual({ kind: "home-repository" });
    expect(result.folders.find((f) => f.path === join(built.home, "code"))?.checked).toBe(true);
  });

  it("shows a bare repository's worktrees unchecked, and counts nothing for them", async () => {
    const built = build([{ kind: "bare", at: ["work"], layout: "dot-bare" }], false);
    const result = await search(built.home, false);
    const work = result.folders.find((f) => f.path === join(built.home, "work"))!;
    expect(work.note).toEqual({ kind: "bare" });
    expect(work.selectable).toBe(false);
    // What the scan really does with proj/.bare + proj/main: drops it.
    expect(await indexedCount([work.path])).toBe(0);
  });

  it("does not open a bare repository's own folder", async () => {
    const built = build([{ kind: "bare", at: [], layout: "named" }], false);
    const result = await search(built.home, false);
    // home, b1, b1/main and b1/b1.git — and nothing inside b1.git.
    expect(result.foldersOpened).toBe(4);
    expect(result.folders.map((f) => f.note)).toEqual([{ kind: "bare" }]);
  });

  it("stops when told to, and says so", async () => {
    const built = build([{ kind: "repo", at: ["code"] }], false);
    const stop = new AbortController();
    stop.abort();
    const result = await searchHomeForRepositories({
      home: built.home,
      platform: process.platform,
      includeProtected: false,
      stop: stop.signal
    });
    expect(result.stoppedEarly).toBe("stopped");
  });

  it("stops at its folder budget, and says so", async () => {
    const built = build(
      [
        { kind: "plain", at: ["a"] },
        { kind: "plain", at: ["b"] },
        { kind: "plain", at: ["c"] }
      ],
      false
    );
    const result = await searchHomeForRepositories({
      home: built.home,
      platform: process.platform,
      includeProtected: false,
      maxFolders: 2
    });
    expect(result.stoppedEarly).toBe("folders");
    expect(result.foldersOpened).toBe(2);
  });
});

describe("Find my repositories, what it skips and what it says", () => {
  it("skips the cloud clients' own folders, not code folders that share a word", async () => {
    const built = build(
      [
        { kind: "repo", at: ["box-tools"] },
        { kind: "repo", at: ["mega-monorepo"] },
        { kind: "repo", at: ["dropbox-sdk"] },
        { kind: "repo", at: ["Dropbox"] },
        { kind: "repo", at: ["OneDrive - Acme"] }
      ],
      false
    );
    const result = await search(built.home, false);
    expect(result.folders.map((f) => relative(built.home, f.path)).sort()).toEqual(
      ["box-tools", "dropbox-sdk", "mega-monorepo"]
    );
    expect(result.cloudSkipped.map((p) => relative(built.home, p)).sort()).toEqual(
      ["Dropbox", "OneDrive - Acme"]
    );
  });

  it("keeps the running count moving while it reads the deepest level", async () => {
    // Every folder past the first two is a leaf at the search's last level,
    // where most of a real walk's folders are.
    const home = realpathSync(mkdtempSync(join(scratch, "deep-")));
    for (let i = 0; i < 120; i += 1) mkdirSync(join(home, "a", "b", `c${i}`), { recursive: true });
    let clock = 0;
    const seen: number[] = [];
    await searchHomeForRepositories({
      home,
      platform: process.platform,
      includeProtected: false,
      // Each reading of the clock is a second later, so the throttle never
      // holds a report back.
      now: () => (clock += 1000),
      maxMs: Number.MAX_SAFE_INTEGER,
      onProgress: (p) => seen.push(p.foldersOpened)
    });
    // The last report is the forced one at the end; the walk reported on the
    // way there too, and the count only grew.
    expect(seen.slice(0, -1).filter((n) => n > 3).length).toBeGreaterThan(1);
    expect([...seen].sort((x, y) => x - y)).toEqual(seen);
  });

  it("names a refused folder only where the OS asks first", async () => {
    // Root ignores directory permissions, so the refusal cannot be made there.
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const home = realpathSync(mkdtempSync(join(scratch, "refused-")));
    mkdirSync(join(home, "Documents"), { mode: 0o000 });
    try {
      for (const platform of ["darwin", "linux"] as const) {
        const result = await searchHomeForRepositories({ home, platform, includeProtected: true });
        expect(result.refused.map((p) => relative(home, p))).toEqual(
          platform === "darwin" ? ["Documents"] : []
        );
      }
    } finally {
      execFileSync("chmod", ["755", join(home, "Documents")]);
    }
  });
});
