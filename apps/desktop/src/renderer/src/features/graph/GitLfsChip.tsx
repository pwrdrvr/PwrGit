import { useCallback, useEffect, useRef, useState } from "react";
import {
  isGitLfsReady,
  type GitLfsReport,
  type GitLfsStatus
} from "@pwrgit/shared";
import { currentPlatform, isMacPlatform } from "../../lib/platform";
import { dispatch } from "../../lib/pwrgit";
import {
  dismissToastKey,
  showErrorToast,
  showInfoToast
} from "../../lib/toast";

/** One toast per repository, not per worktree: sixteen visited worktrees of a
 *  broken repo raise one card, and a later outcome for the same repo replaces
 *  it in place rather than stacking. */
function toastKey(repoPath: string): string {
  return `git-lfs:${repoPath}`;
}

type RequiredLfsStatus = Extract<GitLfsStatus, { required: true }>;

function versionLabel(version: string | undefined): string {
  return version?.split(/\s/, 1)[0] ?? "Git LFS";
}

/** The status sentence every surface shares; only the subject differs — the
 *  repo's name in a toast, "This repository" in the chip tooltip. */
function storyLine(subject: string, status: RequiredLfsStatus): string {
  if (isGitLfsReady(status)) {
    return (
      `${subject} stores large files with Git LFS. ` +
      `${versionLabel(status.version)} is available to PwrGit and the ` +
      `Git LFS filters are configured.`
    );
  }
  const problems = [
    !status.installed && "PwrGit cannot run Git LFS",
    !status.configured && "the Git LFS filters are not configured"
  ]
    .filter(Boolean)
    .join(" and ");
  return `${subject} stores large files with Git LFS, but ${problems}.`;
}

const POINTER_WARNING =
  "Until this is fixed, large files may remain small text pointer files " +
  "instead of their real contents.";

function setupCommands(status: RequiredLfsStatus, platform: string): string {
  const lines: string[] = [];
  if (!status.installed) {
    if (isMacPlatform(platform)) lines.push("brew install git-lfs");
    else if (platform === "win32") lines.push("winget install GitHub.GitLFS");
    else lines.push("# install git-lfs with your package manager");
  }
  lines.push("git lfs install", "git lfs pull");
  return lines.join("\n");
}

/** Window-level news from one check. Deliberately NOT behind the component's
 *  stale-response guard: the main process consumes the once-per-repo
 *  `announceReady` while answering, so a superseded response may be the only
 *  one that will ever carry it — dropping it would lose the announcement for
 *  good and leave a standing complaint unreplaced. Toasts are keyed per repo,
 *  so acting on a superseded response still reports that repo truthfully. */
function raiseToasts(
  report: GitLfsReport,
  repoName: string,
  key: string,
  platform: string
): void {
  const { status, announceReady } = report;
  // A checkout without LFS rules says nothing about the repo's setup — a
  // sibling worktree's rules may still be broken — so it neither raises the
  // complaint nor takes it down (recordLfsOutcome holds the same line).
  if (!status.required) return;
  if (!isGitLfsReady(status)) {
    showErrorToast({
      key,
      sticky: true,
      // The probe succeeded — the broken setup left nothing in the logs.
      showLogsAction: false,
      title: "Git LFS setup needed",
      message: `${storyLine(repoName, status)} ${POINTER_WARNING}`,
      detail: setupCommands(status, platform)
    });
  } else if (announceReady) {
    // Same key: a repair that follows a standing complaint replaces it in
    // place with the confirmation, which then auto-dismisses.
    showInfoToast({
      key,
      title: "Git LFS ready",
      message: storyLine(repoName, status)
    });
  } else {
    // Ready and already announced: nothing to celebrate, but a working setup
    // must not leave yesterday's complaint standing.
    dismissToastKey(key);
  }
}

/**
 * Git LFS readiness for the selected worktree, worn as a header chip instead
 * of the old inline banner (which reflowed the graph every time it appeared
 * and left). The chip is the standing surface; toasts carry the news:
 *
 * - Broken setup → a sticky error toast on every open, keyed per repo, with
 *   the repair commands in its detail.
 * - Working setup → one auto-dismissing confirmation per repo, re-announced
 *   only after a breakage (`announceReady` is the main process's call), and
 *   any standing complaint for the repo comes down either way.
 * - No LFS rules → nothing rendered and nothing said.
 */
export function GitLfsChip({
  repoId,
  repoName,
  repoPath,
  worktreeId,
  platform
}: {
  repoId: string;
  repoName: string;
  repoPath: string;
  worktreeId: string;
  /** Explicit only in deterministic platform tests. Resolved lazily at the
   *  one place it matters (toast repair commands), so rendering never
   *  touches the preload bridge. */
  platform?: string;
}) {
  const [status, setStatus] = useState<GitLfsStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const requestId = useRef(0);

  const check = useCallback(async () => {
    const request = ++requestId.current;
    setChecking(true);
    const result = await dispatch("repo:getGitLfsStatus", {
      repoId,
      worktreeId
    });
    if (result.ok) {
      raiseToasts(
        result.value,
        repoName,
        toastKey(repoPath),
        platform ?? currentPlatform()
      );
    }
    // Superseded: the newer request owns the component's state. The toasts
    // above were handled regardless — they are window-level, not ours.
    if (request !== requestId.current) return;
    setChecking(false);
    if (result.ok) setStatus(result.value.status);
  }, [platform, repoId, repoName, repoPath, worktreeId]);

  // The chip is a repo-level fact, so the previous answer stays on screen
  // while a sibling worktree's re-check is in flight; only a repo change
  // blanks it (a stale chip there would describe a different repository).
  useEffect(() => {
    setStatus(null);
  }, [repoId]);

  useEffect(() => {
    void check();
    return () => {
      requestId.current += 1;
    };
  }, [check]);

  if (status === null || !status.required) return null;

  if (isGitLfsReady(status)) {
    return (
      <span
        className="lfs-chip lfs-chip--ok"
        title={storyLine("This repository", status)}
      >
        LFS
        {/* The title is pointer-only; hand the accessibility tree the same
            sentence the old banner used to keep in the DOM. */}
        <span className="a11y-sr-only">
          {` — ${storyLine("This repository", status)}`}
        </span>
      </span>
    );
  }
  return (
    <button
      className="lfs-chip lfs-chip--broken"
      type="button"
      // aria-busy, not disabled: disabling mid-probe would blur a keyboard
      // user's focus to <body> on every re-check.
      aria-busy={checking}
      aria-label="Git LFS setup needed — check again"
      title={
        `${storyLine("This repository", status)} ${POINTER_WARNING} ` +
        `Click to check again.`
      }
      onClick={() => {
        if (!checking) void check();
      }}
    >
      LFS
    </button>
  );
}
