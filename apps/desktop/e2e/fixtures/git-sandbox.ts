import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Deterministic, self-contained git — never read the developer's global/system
// config or identity (which would make commits non-reproducible or fail in CI).
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "PwrGit Test",
  GIT_AUTHOR_EMAIL: "test@pwrgit.dev",
  GIT_COMMITTER_NAME: "PwrGit Test",
  GIT_COMMITTER_EMAIL: "test@pwrgit.dev"
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8"
  }).trim();
}

const slug = (branch: string): string => branch.replace(/\//g, "-");

export type TestRepo = {
  name: string;
  /** Primary worktree (the repo root that gets scanned). */
  path: string;
  /** Add a linked worktree on a new branch; returns its path. */
  addWorktree: (branch: string, opts?: { dirty?: boolean }) => string;
  /** Create a branch ref at HEAD without checking it out (switchable). */
  createBranch: (branch: string) => void;
};

export type GitSandbox = {
  /** Directory added as a profile root — the app scans this for repos. */
  reposDir: string;
  /** Where the app is told to create NEW worktrees (settings.worktreeRoot). */
  worktreeRoot: string;
  /** Run a raw git command in a checkout (test setup escape hatch). */
  git: (cwd: string, ...args: string[]) => string;
  /** Write a file and commit it in a checkout. */
  commit: (cwd: string, file: string, message: string) => void;
  /** Like commit, but authored by someone else (tests "not mine" paths). */
  commitAs: (email: string, cwd: string, file: string, message: string) => void;
  /**
   * Empty commit with a pinned author+committer date. Branch-ordering tests
   * need strictly increasing timestamps: git dates have 1-second resolution,
   * so a tight commit loop lands whole batches in the same second and
   * `--sort=-committerdate` breaks the ties arbitrarily.
   */
  commitEmptyAt: (cwd: string, message: string, epochSeconds: number) => void;
  makeRepo: (name: string, opts?: { worktrees?: string[] }) => TestRepo;
  /** A repo whose primary branch is `behindBy` commits behind its origin. */
  makeRepoBehindRemote: (
    name: string,
    opts?: { behindBy?: number }
  ) => TestRepo;
  /** A tracked release branch synced with origin but behind a newer main. */
  makeRepoWithSyncedReleaseBranch: (
    name: string,
    opts?: { mainAheadBy?: number; backports?: number }
  ) => TestRepo;
  /**
   * A release branch in its own worktree, diverged from its upstream: one
   * commit of ours that was never pushed, one of theirs we fetched but never
   * applied. Returns the release worktree's path alongside the repo.
   */
  makeRepoWithDivergedReleaseBranch: (
    name: string
  ) => TestRepo & { releasePath: string };
  /** Rewritten commits plus work unique to both local and upstream. */
  makeRepoWithRewrittenDivergence: (
    name: string,
    opts?: { paired?: number; localOnly?: number; remoteOnly?: number }
  ) => TestRepo;
  cleanup: () => void;
};

/**
 * A throwaway directory tree with real git repos + worktrees, laid out so the
 * app scans `reposDir` and discovers each repo's linked worktrees via
 * `git worktree list`. Call cleanup() (in afterEach) to delete everything.
 */
export function createGitSandbox(): GitSandbox {
  // realpath so roots match git's canonical worktree paths — on macOS tmpdir()
  // is /var/… symlinked to /private/var/…, and on Windows CI runners TEMP is
  // the 8.3 short form (C:\Users\RUNNER~1\…) while git reports the long path
  // (C:/Users/runneradmin/…). Either would break root-prefix grouping (real
  // user paths aren't symlinked or shortened). `.native` is what expands 8.3
  // names — the JS implementation only resolves symlinks.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-e2e-")));
  const reposDir = join(base, "repos");
  const worktreesDir = join(base, "worktrees");
  const worktreeRoot = join(base, "new-worktrees");
  const remotesDir = join(base, "remotes");
  mkdirSync(reposDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(remotesDir, { recursive: true });

  const initRepo = (name: string): string => {
    const repoPath = join(reposDir, name);
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, "init", "-b", "main");
    writeFileSync(join(repoPath, "README.md"), `# ${name}\n`);
    git(repoPath, "add", "-A");
    git(repoPath, "commit", "-m", "initial commit");
    return repoPath;
  };

  const worktreeAdder =
    (name: string, repoPath: string) =>
    (branch: string, wtOpts: { dirty?: boolean } = {}): string => {
      const wtPath = join(worktreesDir, name, slug(branch));
      mkdirSync(join(worktreesDir, name), { recursive: true });
      git(repoPath, "worktree", "add", "-b", branch, wtPath);
      if (wtOpts.dirty === true) {
        writeFileSync(join(wtPath, "uncommitted.txt"), "work in progress\n");
      }
      return wtPath;
    };

  const makeRepo = (
    name: string,
    opts: { worktrees?: string[] } = {}
  ): TestRepo => {
    const repoPath = initRepo(name);
    const addWorktree = worktreeAdder(name, repoPath);
    for (const branch of opts.worktrees ?? []) addWorktree(branch);
    return {
      name,
      path: repoPath,
      addWorktree,
      createBranch: (branch: string) => git(repoPath, "branch", branch)
    };
  };

  const makeRepoBehindRemote = (
    name: string,
    opts: { behindBy?: number } = {}
  ): TestRepo => {
    const behindBy = opts.behindBy ?? 1;
    const repoPath = initRepo(name);
    // Bare remote lives outside reposDir so it isn't itself scanned as a repo.
    git(remotesDir, "init", "--bare", `${name}.git`);
    git(repoPath, "remote", "add", "origin", join(remotesDir, `${name}.git`));
    git(repoPath, "push", "-u", "origin", "main");
    // Advance the remote, then rewind local + fetch so main trails origin/main.
    for (let i = 0; i < behindBy; i += 1) {
      writeFileSync(join(repoPath, `remote-${i}.txt`), `${i}\n`);
      git(repoPath, "add", "-A");
      git(repoPath, "commit", "-m", `remote commit ${i}`);
    }
    git(repoPath, "push", "origin", "main");
    git(repoPath, "reset", "--hard", `HEAD~${behindBy}`);
    git(repoPath, "fetch", "origin");
    return {
      name,
      path: repoPath,
      addWorktree: worktreeAdder(name, repoPath),
      createBranch: (branch: string) => git(repoPath, "branch", branch)
    };
  };

  const makeRepoWithSyncedReleaseBranch = (
    name: string,
    opts: { mainAheadBy?: number; backports?: number } = {}
  ): TestRepo => {
    const mainAheadBy = opts.mainAheadBy ?? 3;
    const backports = opts.backports ?? 1;
    const repoPath = initRepo(name);
    const remotePath = join(remotesDir, `${name}.git`);
    git(remotesDir, "init", "--bare", `${name}.git`);
    git(remotePath, "symbolic-ref", "HEAD", "refs/heads/main");
    git(repoPath, "remote", "add", "origin", remotePath);
    git(repoPath, "push", "-u", "origin", "main");
    git(repoPath, "remote", "set-head", "origin", "--auto");

    const addWorktree = worktreeAdder(name, repoPath);
    const releasePath = addWorktree("releases/1.0");
    for (let i = 0; i < backports; i += 1) {
      writeFileSync(join(releasePath, `backport-${i}.txt`), `${i}\n`);
      git(releasePath, "add", "-A");
      git(releasePath, "commit", "-m", `backport ${i}`);
    }
    git(releasePath, "push", "-u", "origin", "releases/1.0");

    for (let i = 0; i < mainAheadBy; i += 1) {
      writeFileSync(join(repoPath, `main-${i}.txt`), `${i}\n`);
      git(repoPath, "add", "-A");
      git(repoPath, "commit", "-m", `main commit ${i}`);
    }
    git(repoPath, "push", "origin", "main");

    return {
      name,
      path: repoPath,
      addWorktree,
      createBranch: (branch: string) => git(repoPath, "branch", branch)
    };
  };

  const makeRepoWithDivergedReleaseBranch = (
    name: string
  ): TestRepo & { releasePath: string } => {
    const repoPath = initRepo(name);
    const remotePath = join(remotesDir, `${name}.git`);
    git(remotesDir, "init", "--bare", `${name}.git`);
    git(remotePath, "symbolic-ref", "HEAD", "refs/heads/main");
    git(repoPath, "remote", "add", "origin", remotePath);
    git(repoPath, "push", "-u", "origin", "main");
    git(repoPath, "remote", "set-head", "origin", "--auto");

    const addWorktree = worktreeAdder(name, repoPath);
    const releasePath = addWorktree("releases/1.0");
    writeFileSync(join(releasePath, "backport-0.txt"), "0\n");
    git(releasePath, "add", "-A");
    git(releasePath, "commit", "-m", "shared backport");
    git(releasePath, "push", "-u", "origin", "releases/1.0");

    // Another machine lands a fix on the release branch and pushes it.
    git(repoPath, "checkout", "-q", "-b", "their-push", "origin/releases/1.0");
    writeFileSync(join(repoPath, "their-fix.txt"), "fix\n");
    git(repoPath, "add", "-A");
    git(repoPath, "commit", "-m", "upstream release fix");
    git(repoPath, "push", "origin", "their-push:releases/1.0");
    git(repoPath, "checkout", "-q", "main");
    git(repoPath, "branch", "-D", "their-push");

    // We commit locally without pushing, then fetch: ahead 1, behind 1.
    writeFileSync(join(releasePath, "prepare.txt"), "prep\n");
    git(releasePath, "add", "-A");
    git(releasePath, "commit", "-m", "prepare release");
    git(repoPath, "fetch", "origin");

    return {
      name,
      path: repoPath,
      releasePath,
      addWorktree,
      createBranch: (branch: string) => git(repoPath, "branch", branch)
    };
  };

  const commit = (cwd: string, file: string, message: string): void => {
    writeFileSync(join(cwd, file), `${message}\n`);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-m", message);
  };

  const commitAs = (
    email: string,
    cwd: string,
    file: string,
    message: string
  ): void => {
    writeFileSync(join(cwd, file), `${message}\n`);
    git(cwd, "add", "-A");
    execFileSync("git", ["commit", "-m", message], {
      cwd,
      env: {
        ...GIT_ENV,
        GIT_AUTHOR_NAME: "Someone Else",
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: "Someone Else",
        GIT_COMMITTER_EMAIL: email
      },
      encoding: "utf8"
    });
  };

  const makeRepoWithRewrittenDivergence = (
    name: string,
    opts: { paired?: number; localOnly?: number; remoteOnly?: number } = {}
  ): TestRepo => {
    const paired = opts.paired ?? 10;
    const localOnly = opts.localOnly ?? 2;
    const remoteOnly = opts.remoteOnly ?? 3;
    const repoPath = initRepo(name);
    const remotePath = join(remotesDir, `${name}.git`);
    git(remotesDir, "init", "--bare", `${name}.git`);
    git(repoPath, "remote", "add", "origin", remotePath);
    git(repoPath, "push", "-u", "origin", "main");
    const base = git(repoPath, "rev-parse", "HEAD");

    for (let index = 0; index < paired; index += 1) {
      commit(repoPath, `shared-${index}.txt`, `feat: shared change ${index}`);
    }
    for (let index = 0; index < localOnly; index += 1) {
      commit(repoPath, `local-${index}.txt`, `feat: local only ${index}`);
    }
    const localTip = git(repoPath, "rev-parse", "HEAD");

    git(repoPath, "reset", "--hard", base);
    for (let index = 0; index < paired; index += 1) {
      commitAs(
        "rewrite@pwrgit.dev",
        repoPath,
        `shared-${index}.txt`,
        `feat: shared change ${index}`
      );
    }
    for (let index = 0; index < remoteOnly; index += 1) {
      commit(repoPath, `remote-${index}.txt`, `feat: remote only ${index}`);
    }
    git(repoPath, "push", "origin", "main");

    git(repoPath, "reset", "--hard", localTip);
    git(repoPath, "fetch", "origin");
    return {
      name,
      path: repoPath,
      addWorktree: worktreeAdder(name, repoPath),
      createBranch: (branch: string) => git(repoPath, "branch", branch)
    };
  };

  const commitEmptyAt = (
    cwd: string,
    message: string,
    epochSeconds: number
  ): void => {
    const date = `${epochSeconds} +0000`;
    execFileSync("git", ["commit", "--allow-empty", "-m", message], {
      cwd,
      env: { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      encoding: "utf8"
    });
  };

  const cleanup = (): void => {
    rmSync(base, { recursive: true, force: true });
  };

  return {
    reposDir,
    worktreeRoot,
    git: (cwd: string, ...args: string[]) => git(cwd, ...args),
    commit,
    commitAs,
    commitEmptyAt,
    makeRepo,
    makeRepoBehindRemote,
    makeRepoWithSyncedReleaseBranch,
    makeRepoWithDivergedReleaseBranch,
    makeRepoWithRewrittenDivergence,
    cleanup
  };
}
