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
  mkdirSync(reposDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  const makeRepo = (
    name: string,
    opts: { worktrees?: string[] } = {}
  ): TestRepo => {
    const repoPath = join(reposDir, name);
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, "init", "-b", "main");
    writeFileSync(join(repoPath, "README.md"), `# ${name}\n`);
    git(repoPath, "add", "-A");
    git(repoPath, "commit", "-m", "initial commit");

    const addWorktree = (
      branch: string,
      wtOpts: { dirty?: boolean } = {}
    ): string => {
      const wtPath = join(worktreesDir, name, slug(branch));
      mkdirSync(join(worktreesDir, name), { recursive: true });
      git(repoPath, "worktree", "add", "-b", branch, wtPath);
      if (wtOpts.dirty === true) {
        writeFileSync(join(wtPath, "uncommitted.txt"), "work in progress\n");
      }
      return wtPath;
    };

    for (const branch of opts.worktrees ?? []) addWorktree(branch);
    return { name, path: repoPath, addWorktree };
  };

  const cleanup = (): void => {
    // Prune worktree admin state first, then nuke the tree.
    rmSync(base, { recursive: true, force: true });
  };

  return { reposDir, worktreeRoot, makeRepo, cleanup };
}
