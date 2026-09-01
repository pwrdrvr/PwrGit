import type {
  DivergenceCommit,
  DivergenceCommitAlignment
} from "@pwrgit/shared";

/**
 * Two diverged commit ranges side by side, with Git's range-diff correspondence
 * drawn between them.
 *
 * This is the one view that separates "your work is about to be destroyed" from
 * "your work is already on the other side under different hashes". Both look
 * identical to an ahead/behind count, so every surface that is about to discard
 * local commits — the diverged-pull recovery dialog and the reset confirmation —
 * shows the same rows rather than a number.
 */

/**
 * `otherOnlyLabel` is the caller's, not a generic one: this view is read by
 * screen readers a row at a time, and "only on the other branch" makes the
 * listener hold a pronoun the rest of the dialog never resolves.
 */
function relationLabel(
  relation: DivergenceCommitAlignment["relation"],
  otherOnlyLabel: string
): string {
  switch (relation) {
    case "equivalent":
      return "Equivalent patch";
    case "changed":
      return "Corresponding commit with changes";
    case "local-only":
      return "Only on the local branch";
    case "upstream-only":
      return otherOnlyLabel;
  }
}

function relationGlyph(
  relation: DivergenceCommitAlignment["relation"]
): string {
  switch (relation) {
    case "equivalent":
      return "=";
    case "changed":
      return "≈";
    case "local-only":
      return "←";
    case "upstream-only":
      return "→";
  }
}

function CommitCell({
  commit,
  absentLabel
}: {
  commit: DivergenceCommit | null;
  absentLabel: string;
}) {
  if (commit === null) {
    return <span className="commit-align__commit-empty">{absentLabel}</span>;
  }

  return (
    <div className="commit-align__commit" title={commit.subject}>
      <code>{commit.shortHash}</code>
      <span className="commit-align__commit-subject">
        {commit.subject || "(no commit message)"}
      </span>
      <span
        className="commit-align__commit-stats"
        aria-label={`${commit.additions} additions, ${commit.deletions} deletions`}
      >
        <span>+{commit.additions}</span>
        <span>−{commit.deletions}</span>
      </span>
    </div>
  );
}

export function CommitAlignment({
  rows,
  localHeading,
  otherHeading,
  localCount,
  otherCount,
  ariaLabel,
  otherAbsentLabel,
  otherOnlyLabel
}: {
  rows: DivergenceCommitAlignment[];
  localHeading: string;
  otherHeading: string;
  localCount: number;
  otherCount: number;
  ariaLabel: string;
  /** Right-cell text when only the local side has a commit on that row. */
  otherAbsentLabel: string;
  /** Relation label for a commit the other side alone carries. */
  otherOnlyLabel: string;
}) {
  return (
    <section className="commit-align">
      <div className="commit-align__head">
        <span>
          {localHeading} <small>{commitCountLabel(localCount)}</small>
        </span>
        <span aria-hidden="true" />
        <span>
          {otherHeading} <small>{commitCountLabel(otherCount)}</small>
        </span>
      </div>
      <div className="commit-align__scroll" tabIndex={0} aria-label={ariaLabel}>
        <div className="commit-align__rows" role="table">
          {rows.map((row, index) => (
            <div
              className={`commit-align__row is-${row.relation}`}
              role="row"
              key={`${row.local?.hash ?? "none"}-${row.upstream?.hash ?? "none"}-${index}`}
            >
              <div role="cell">
                <CommitCell
                  commit={row.local}
                  absentLabel="Not present locally"
                />
              </div>
              <span
                className="commit-align__relation"
                aria-label={relationLabel(row.relation, otherOnlyLabel)}
                title={relationLabel(row.relation, otherOnlyLabel)}
              >
                {relationGlyph(row.relation)}
              </span>
              <div role="cell">
                <CommitCell commit={row.upstream} absentLabel={otherAbsentLabel} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function commitCountLabel(count: number): string {
  return `${count} ${count === 1 ? "commit" : "commits"}`;
}

/**
 * How many of the local-side commits have no counterpart on the other branch.
 *
 * These are the ones a reset actually strands: every other leaving commit is
 * the same patch the target already carries under a different object name.
 */
export function strandedCommitCount(
  rows: readonly DivergenceCommitAlignment[]
): number {
  return rows.filter((row) => row.relation === "local-only").length;
}

/** Local commits Git matched to a commit on the other branch. */
export function rewrittenCommitCount(
  rows: readonly DivergenceCommitAlignment[]
): number {
  return rows.filter((row) => row.local !== null && row.upstream !== null)
    .length;
}

/** The mirror of `strandedCommitCount`: rows only the other branch carries. */
export function otherOnlyCommitCount(
  rows: readonly DivergenceCommitAlignment[]
): number {
  return rows.filter((row) => row.relation === "upstream-only").length;
}
