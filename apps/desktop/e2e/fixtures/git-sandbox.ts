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
};

export type GitSandbox = {
  /** Directory added as a profile root — the app scans this for repos. */
  reposDir: string;
  /** Where the app is told to create NEW worktrees (settings.worktreeRoot). */
  worktreeRoot: string;
  makeRepo: (name: string, opts?: { worktrees?: string[] }) => TestRepo;
  /** A repo whose primary branch is `behindBy` commits behind its origin. */
  makeRepoBehindRemote: (
    name: string,
    opts?: { behindBy?: number }
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
  // is /var/… symlinked to /private/var/…, which would break root-prefix
  // grouping (real user paths like ~/GIPHY aren't symlinked).
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-e2e-")));
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
    return { name, path: repoPath, addWorktree };
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
    return { name, path: repoPath, addWorktree: worktreeAdder(name, repoPath) };
  };

  const cleanup = (): void => {
    rmSync(base, { recursive: true, force: true });
  };

  return { reposDir, worktreeRoot, makeRepo, makeRepoBehindRemote, cleanup };
}
