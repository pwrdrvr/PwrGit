import { useCallback, useEffect, useRef, useState } from "react";
import type { GitLfsStatus } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";

export const LFS_READY_DISMISS_MS = 8_000;

function versionLabel(version: string | undefined): string {
  return version?.split(/\s/, 1)[0] ?? "Git LFS";
}

export function GitLfsNotice({
  repoId,
  worktreeId
}: {
  repoId: string;
  worktreeId: string;
}) {
  const [status, setStatus] = useState<GitLfsStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const requestId = useRef(0);

  const check = useCallback(async () => {
    const request = ++requestId.current;
    setChecking(true);
    const result = await dispatch("repo:getGitLfsStatus", {
      repoId,
      worktreeId
    });
    if (request !== requestId.current) return;
    if (result.ok) setStatus(result.value);
    setChecking(false);
  }, [repoId, worktreeId]);

  useEffect(() => {
    setStatus(null);
    setDismissed(false);
    void check();
    return () => {
      requestId.current += 1;
    };
  }, [check]);

  const ready =
    status?.required === true && status.installed && status.configured;
  useEffect(() => {
    if (!ready || dismissed) return;
    const timeout = window.setTimeout(
      () => setDismissed(true),
      LFS_READY_DISMISS_MS
    );
    return () => window.clearTimeout(timeout);
  }, [dismissed, ready]);

  if (status === null || !status.required || dismissed) return null;

  const availability = status.installed
    ? `${versionLabel(status.version)} is available to PwrGit`
    : "PwrGit cannot run Git LFS";
  const configuration = status.configured
    ? "the Git LFS filters are configured"
    : "the Git LFS filters are not configured";

  return (
    <section
      className={`lfs-notice${ready ? " lfs-notice--ready" : " lfs-notice--warn"}`}
      aria-live="polite"
    >
      <div className="lfs-notice__summary">
        <span className="lfs-notice__icon" aria-hidden="true">
          {ready ? "✓" : "!"}
        </span>
        <div className="lfs-notice__copy">
          <div className="lfs-notice__title-row">
            <strong>Git LFS required</strong>
            <span className="lfs-notice__status">
              {ready ? "Ready" : "Setup needed"}
            </span>
          </div>
          <p>
            This repository stores large files with Git LFS. {availability} and{" "}
            {configuration}.
          </p>
          {!ready && (
            <p>
              Until this is fixed, large files may remain small text pointer
              files instead of their real contents.
            </p>
          )}
        </div>
        {ready ? (
          <button
            className="lfs-notice__action"
            type="button"
            onClick={() => setDismissed(true)}
          >
            Dismiss
          </button>
        ) : (
          <button
            className="lfs-notice__action"
            type="button"
            disabled={checking}
            onClick={() => void check()}
          >
            {checking ? "Checking…" : "Check again"}
          </button>
        )}
      </div>

      {!ready && (
        <details className="lfs-notice__setup" open>
          <summary>Setup instructions</summary>
          <p>Run the commands for your platform, then check again.</p>
          <div className="lfs-notice__platforms">
            <section>
              <h3>macOS</h3>
              <pre>{`brew install git-lfs\ngit lfs install\ngit lfs pull`}</pre>
            </section>
            <section>
              <h3>Windows (PowerShell)</h3>
              <pre>{`winget install GitHub.GitLFS\ngit lfs install\ngit lfs pull`}</pre>
            </section>
            <section>
              <h3>Linux</h3>
              <p>I think you know what to do.</p>
            </section>
          </div>
        </details>
      )}
    </section>
  );
}
