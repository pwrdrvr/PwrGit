import type { PrSummary } from "@pwrgit/shared";
import { DiffStat } from "../diff/DiffStat";
import { longWhen } from "../graph/graph-view";

/**
 * The PR chip's hover card.
 *
 * Structured sibling of `CommitContextCard`: same eyebrow / title / row rhythm
 * and the same tokens, so two hover cards in one app read as one family.
 *
 * EVERY section below is conditional, and that is load-bearing rather than
 * defensive. The detail fields are optional on `PrSummary` because a row cached
 * before they existed will never gain them — a change request that reached a
 * terminal state stops being refreshed, so its row is frozen. The card has to
 * look finished with any subset present: no dashes, no "unknown", no empty
 * headers. A missing count is never rendered as zero; "not known" and "changes
 * nothing" are different claims and we only have evidence for the second.
 */
export function PrStatusCard({
  pr,
  now = Date.now()
}: {
  pr: PrSummary;
  /** Injected by tests so age rows are deterministic. */
  now?: number;
}) {
  const title = pr.title.trim();
  const changes = readChanges(pr);
  const timeline = readTimeline(pr, now);
  const isDraft = pr.state === "open" && pr.isDraft;

  return (
    <>
      <div className="pr-status-card__header">
        <span className="pr-status-card__eyebrow">{eyebrow(pr)}</span>
        <span className="pr-status-card__identity">{identity(pr)}</span>
      </div>
      {title !== "" ? (
        <div className="pr-status-card__title">{title}</div>
      ) : null}
      {pr.headRefName !== undefined ? (
        <div className="pr-status-card__branch">
          <span className="pr-status-card__branch-name">{pr.headRefName}</span>
          {pr.baseRefName !== undefined ? (
            <>
              <span aria-hidden="true" className="pr-status-card__branch-arrow">
                →
              </span>
              <span className="pr-status-card__branch-base">
                {pr.baseRefName}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="pr-status-card__status">
        <span
          aria-hidden="true"
          className={`pr-status-card__dot pr-status-card__dot--${
            isDraft ? "draft" : pr.state
          }`}
        />
        <span>{isDraft ? `${pr.state} · draft` : pr.state}</span>
      </div>
      {changes !== undefined ? (
        <div className="pr-status-card__section">
          <span className="pr-status-card__section-title">Changes</span>
          <div className="pr-status-card__diff">
            {changes.diff !== undefined ? (
              <DiffStat
                additions={changes.diff.additions}
                deletions={changes.diff.deletions}
              />
            ) : (
              <span />
            )}
            {changes.files !== undefined ? (
              <span className="pr-status-card__files">{changes.files}</span>
            ) : null}
          </div>
          {changes.additionsPercent !== undefined ? (
            <div aria-hidden="true" className="pr-status-card__meter">
              <span
                className="pr-status-card__meter-additions"
                style={{ width: `${changes.additionsPercent}%` }}
              />
              <span
                className="pr-status-card__meter-deletions"
                style={{ width: `${100 - changes.additionsPercent}%` }}
              />
            </div>
          ) : null}
          {changes.commits !== undefined ? (
            <div className="pr-status-card__caption">{changes.commits}</div>
          ) : null}
        </div>
      ) : null}
      {timeline.length > 0 ? (
        <div className="pr-status-card__section">
          <span className="pr-status-card__section-title">Timeline</span>
          {timeline.map((row) => (
            <div className="pr-status-card__row" key={row.label}>
              <span className="pr-status-card__row-label">{row.label}</span>
              <span className="pr-status-card__row-value">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * Each forge's own word for the thing, so the card matches what the user sees
 * on the site it came from. An unstamped row predates forge identity; "pull
 * request" is this app's neutral term and the honest default.
 */
function eyebrow(pr: PrSummary): string {
  return pr.forge === "gitlab" ? "Merge request" : "Pull request";
}

/**
 * `path#4` on GitHub, `path!4` on GitLab — each forge's native reference form,
 * which is what a reader can paste back into it.
 */
function identity(pr: PrSummary): string {
  const sigil = pr.forge === "gitlab" ? "!" : "#";
  return `${pr.repoPath ?? ""}${sigil}${pr.number}`;
}

type Changes = {
  diff?: { additions: number; deletions: number };
  files?: string;
  commits?: string;
  /** Only when the split is meaningful — a 0/0 diff has no proportion. */
  additionsPercent?: number;
};

function readChanges(pr: PrSummary): Changes | undefined {
  const hasDiff = pr.additions !== undefined && pr.deletions !== undefined;
  const changes: Changes = {
    ...(hasDiff
      ? { diff: { additions: pr.additions!, deletions: pr.deletions! } }
      : {}),
    ...(pr.changedFiles === undefined
      ? {}
      : { files: plural(pr.changedFiles, "file") }),
    ...(pr.commitCount === undefined
      ? {}
      : { commits: plural(pr.commitCount, "commit") })
  };
  if (hasDiff) {
    const total = pr.additions! + pr.deletions!;
    if (total > 0) {
      changes.additionsPercent = Math.round((pr.additions! / total) * 100);
    }
  }
  return Object.keys(changes).length === 0 ? undefined : changes;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Only the transitions this change request actually reached. A merged one is
 * not also "closed", even though GitHub reports a `closedAt` for it.
 */
function readTimeline(
  pr: PrSummary,
  now: number
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (pr.createdAt !== undefined) {
    rows.push({ label: "Opened", value: age(pr.createdAt, now) });
  }
  if (pr.mergedAt !== undefined) {
    rows.push({ label: "Merged", value: age(pr.mergedAt, now) });
  } else if (pr.closedAt !== undefined && pr.state === "closed") {
    rows.push({ label: "Closed", value: age(pr.closedAt, now) });
  }
  return rows;
}

function age(epochMs: number, now: number): string {
  return longWhen(new Date(epochMs).toISOString(), now);
}
