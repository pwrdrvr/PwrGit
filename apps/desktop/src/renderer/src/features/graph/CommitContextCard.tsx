import type {
  Commit,
  CommitStats,
  GitHubCommitAuthorIdentity
} from "@pwrgit/shared";
import type { ReactNode } from "react";
import { DiffStat } from "../diff/DiffStat";
import { CopyTarget } from "../shell/CopyTarget";
import { localWhen, longWhen } from "./graph-view";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function redundantGitHubLogin(authorName: string, login: string): boolean {
  return authorName.trim().toLocaleLowerCase() === login.trim().toLocaleLowerCase();
}

function DetailRow({
  label,
  children
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="commit-context-card__row">
      <span className="commit-context-card__row-label">{label}</span>
      <span className="commit-context-card__row-value">{children}</span>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

/** Structured local-Git content with optional exact-commit GitHub presentation. */
export function CommitContextCard({
  commit,
  viewingBranch,
  defaultBranch,
  defaultRef,
  now,
  stats,
  githubIdentity
}: {
  commit: Commit;
  /** Present only when this commit is exclusive to the viewed HEAD. */
  viewingBranch: string | null;
  defaultBranch: string;
  defaultRef: string;
  now: number;
  /** Undefined while the local numstat request is in flight; null on failure. */
  stats: CommitStats | null | undefined;
  /** Present only after an exact GitHub commit proof verified it. */
  githubIdentity?: GitHubCommitAuthorIdentity | undefined;
}) {
  const authorName = commit.authorName.trim() || "Unknown author";
  // Local Git authorship remains primary. When it already is the proven
  // GitHub handle, reserve the same line for a stable card height but do not
  // repeat the name as both `huntharo` and `@huntharo`.
  const githubLogin =
    githubIdentity === undefined ||
    redundantGitHubLogin(authorName, githubIdentity.login)
      ? undefined
      : githubIdentity.login;

  return (
    <>
      <div className="commit-context-card__header">
        <span className="commit-context-card__eyebrow">Commit context</span>
        <span className="commit-context-card__hash-actions">
          <code className="commit-context-card__short-hash">{commit.shortHash}</code>
          <CopyTarget
            value={commit.shortHash}
            label="Copy short commit hash"
            hint={`Copy short SHA ${commit.shortHash}`}
            className="commit-context-card__hash-copy copyable"
          >
            <CopyIcon />
          </CopyTarget>
          <CopyTarget
            value={commit.hash}
            label="Copy full commit hash"
            hint={`Copy full SHA ${commit.hash}`}
            className="commit-context-card__hash-copy commit-context-card__hash-copy--full copyable"
          >
            <CopyIcon />
            <span aria-hidden="true">Full</span>
          </CopyTarget>
        </span>
      </div>
      <div className="commit-context-card__subject">{commit.subject}</div>

      <div className="commit-context-card__identity">
        <span className="commit-context-card__avatar" aria-hidden="true">
          <span className="commit-context-card__avatar-initials">
            {initials(authorName)}
          </span>
          {githubIdentity?.avatarUrl !== undefined ? (
            <img
              className="commit-context-card__avatar-image"
              src={githubIdentity.avatarUrl}
              alt=""
              width={28}
              height={28}
              decoding="sync"
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          ) : null}
        </span>
        <span className="commit-context-card__author">
          <strong>{authorName}</strong>
          <span>{commit.authorEmail}</span>
          <span
            className={
              githubLogin === undefined
                ? "commit-context-card__github-login commit-context-card__github-login--placeholder"
                : "commit-context-card__github-login"
            }
            aria-hidden={githubLogin === undefined}
          >
            {githubLogin === undefined ? "\u00a0" : `@${githubLogin}`}
          </span>
        </span>
      </div>

      <div className="commit-context-card__section">
        <DetailRow label="Committed">
          <time dateTime={commit.committedAt}>{localWhen(commit.committedAt)}</time>
        </DetailRow>
        <DetailRow label="Age">{longWhen(commit.committedAt, now)}</DetailRow>
        <DetailRow label="Changes">
          {stats === undefined ? (
            <span className="commit-context-card__pending">Loading…</span>
          ) : stats === null ? (
            <span className="commit-context-card__pending">Unavailable</span>
          ) : (
            <DiffStat additions={stats.additions} deletions={stats.deletions} />
          )}
        </DetailRow>
      </div>

      {viewingBranch !== null && (
        <div className="commit-context-card__section">
          <DetailRow label="Viewing branch">
            <code>{viewingBranch}</code>
          </DetailRow>
          {viewingBranch === defaultBranch && defaultRef !== defaultBranch ? (
            <DetailRow label="Base ref">
              <code>{defaultRef}</code>
            </DetailRow>
          ) : (
            <DetailRow label="Base branch">
              <code>{defaultBranch}</code>
            </DetailRow>
          )}
        </div>
      )}
    </>
  );
}
