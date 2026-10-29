import type {
  DiagnosticsRepositoryContext,
  PwrGitError,
  Repo,
  Result,
  Worktree
} from "@pwrgit/shared";

/** What this window shows, for Help → Copy Diagnostics Info. */
export function diagnosticsRepository(
  repo: Repo | null,
  worktree: Worktree | null
): DiagnosticsRepositoryContext | null {
  if (repo === null) return null;
  return {
    name: repo.name,
    path: repo.path,
    worktreePath: worktree?.path ?? null,
    branch: worktree?.branch ?? null
  };
}

export type DiagnosticsToast =
  | { tone: "info"; message: string }
  | { tone: "error"; message: string }
  | null;

const WITH_REPO =
  "PwrGit's build, processes, log and data paths, Git and this window's repository are on the clipboard, ready to paste into an issue.";
const WITHOUT_REPO =
  "PwrGit's build, processes, log and data paths and Git are on the clipboard, ready to paste into an issue.";

/**
 * The confirmation for a copy. `menuCopied` is main's first copy; `recopy` is
 * this window's, with the repository. Null when the user copied something
 * else in between: theirs is kept, and a toast would claim otherwise.
 */
export function diagnosticsCopiedToast(
  menuCopied: boolean,
  recopy: Result<{ written: boolean }, PwrGitError>
): DiagnosticsToast {
  if (recopy.ok) {
    return recopy.value.written ? { tone: "info", message: WITH_REPO } : null;
  }
  return menuCopied
    ? { tone: "info", message: WITHOUT_REPO }
    : { tone: "error", message: recopy.error.message };
}
