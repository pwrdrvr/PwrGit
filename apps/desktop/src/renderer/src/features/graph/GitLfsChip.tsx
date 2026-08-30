import { useCallback, useEffect, useRef, useState } from "react";
import type { GitLfsStatus } from "@pwrgit/shared";
import { currentPlatform } from "../../lib/platform";
import { dispatch } from "../../lib/pwrgit";
import {
  dismissToastKey,
  showErrorToast,
  showInfoToast
} from "../../lib/toast";

/** One toast per repository, not per worktree: sixteen visited worktrees of a
 *  broken repo raise one card, and a later outcome for the same repo replaces
 *  it in place rather than stacking. */
export function gitLfsToastKey(repoPath: string): string {
  return `git-lfs:${repoPath}`;
}

type RequiredLfsStatus = Extract<GitLfsStatus, { required: true }>;

function versionLabel(version: string | undefined): string {
  return version?.split(/\s/, 1)[0] ?? "Git LFS";
}

function readyClause(status: RequiredLfsStatus): string {
  return `${versionLabel(status.version)} is available to PwrGit and the Git LFS filters are configured`;
}

function problemClause(status: RequiredLfsStatus): string {
  if (!status.installed && !status.configured) {
    return "PwrGit cannot run Git LFS and the Git LFS filters are not configured";
  }
  if (!status.installed) return "PwrGit cannot run Git LFS";
  return "the Git LFS filters are not configured";
}

function setupCommands(status: RequiredLfsStatus, platform: string): string {
  const lines: string[] = [];
  if (!status.installed) {
    if (platform === "darwin") lines.push("brew install git-lfs");
    else if (platform === "win32") lines.push("winget install GitHub.GitLFS");
    else lines.push("# install git-lfs with your package manager");
  }
  lines.push("git lfs install", "git lfs pull");
  return lines.join("\n");
}

/**
 * Git LFS readiness for the selected worktree, worn as a header chip instead
 * of the old inline banner (which reflowed the graph every time it appeared
 * and left). The chip is the standing surface; toasts carry the news:
 *
 * - Broken setup → a sticky error toast on every open, keyed per repo, with
 *   the repair commands in its detail.
 * - Working setup → one auto-dismissing confirmation per repo, re-announced
 *   only after a breakage (`announceReady` is the main process's call).
 * - No LFS rules → nothing, and any standing complaint for the repo is taken
 *   down with it.
 */
export function GitLfsChip({
  repoId,
  repoName,
  repoPath,
  worktreeId
}: {
  repoId: string;
  repoName: string;
  repoPath: string;
  worktreeId: string;
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
    if (request !== requestId.current) return;
    setChecking(false);
    if (!result.ok) return;
    const { status: fresh, announceReady } = result.value;
    setStatus(fresh);

    const key = gitLfsToastKey(repoPath);
    if (!fresh.required) {
      // A standing complaint must not outlive the rules that justified it
      // (e.g. this branch carries no LFS attributes).
      dismissToastKey(key);
      return;
    }
    if (!fresh.installed || !fresh.configured) {
      showErrorToast({
        key,
        sticky: true,
        // The probe succeeded — the broken setup left nothing in the logs.
        showLogsAction: false,
        title: "Git LFS setup needed",
        message:
          `${repoName} stores large files with Git LFS, but ` +
          `${problemClause(fresh)}. Until this is fixed, large files may ` +
          `remain small text pointer files instead of their real contents.`,
        detail: setupCommands(fresh, currentPlatform())
      });
    } else if (announceReady) {
      // Same key: a repair that follows a standing complaint replaces it in
      // place with the confirmation, which then auto-dismisses.
      showInfoToast({
        key,
        title: "Git LFS ready",
        message: `${repoName} stores large files with Git LFS. ${readyClause(fresh)}.`
      });
    }
  }, [repoId, repoName, repoPath, worktreeId]);

  useEffect(() => {
    setStatus(null);
    void check();
    return () => {
      requestId.current += 1;
    };
  }, [check]);

  if (status === null || !status.required) return null;

  if (status.installed && status.configured) {
    return (
      <span
        className="lfs-chip lfs-chip--ok"
        title={`This repository stores large files with Git LFS. ${readyClause(status)}.`}
      >
        LFS
      </span>
    );
  }
  return (
    <button
      className="lfs-chip lfs-chip--broken"
      type="button"
      disabled={checking}
      aria-label="Git LFS setup needed — check again"
      title={
        `This repository stores large files with Git LFS, but ` +
        `${problemClause(status)}. Large files may remain small text pointer ` +
        `files. Click to check again.`
      }
      onClick={() => void check()}
    >
      LFS
    </button>
  );
}
