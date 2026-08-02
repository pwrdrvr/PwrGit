import type { Commit, CommitStats } from "@pwrgit/shared";
import type { ReactNode } from "react";
import { DiffStat } from "../diff/DiffStat";
import { localWhen, longWhen } from "./graph-view";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
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

/** Structured, local-Git-only content for the lineage commit hover card. */
export function CommitContextCard({
  commit,
  viewingBranch,
  defaultBranch,
  now,
  stats
}: {
  commit: Commit;
  viewingBranch: string;
  defaultBranch: string;
  now: number;
  /** Undefined while the local numstat request is in flight; null on failure. */
  stats: CommitStats | null | undefined;
}) {
  const authorName = commit.authorName.trim() || "Unknown author";

  return (
    <>
      <div className="commit-context-card__header">
        <span className="commit-context-card__eyebrow">Commit context</span>
        <span className="commit-context-card__short-hash">{commit.shortHash}</span>
      </div>
      <div className="commit-context-card__subject">{commit.subject}</div>

      <div className="commit-context-card__identity">
        <span className="commit-context-card__avatar" aria-hidden="true">
          {initials(authorName)}
        </span>
        <span className="commit-context-card__author">
          <strong>{authorName}</strong>
          <span>{commit.authorEmail}</span>
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

      <div className="commit-context-card__section">
        <DetailRow label="Viewing branch">
          <code>{viewingBranch}</code>
        </DetailRow>
        <DetailRow label="Base branch">
          <code>{defaultBranch}</code>
        </DetailRow>
        <DetailRow label="Commit">
          <code>{commit.hash}</code>
        </DetailRow>
      </div>
    </>
  );
}
