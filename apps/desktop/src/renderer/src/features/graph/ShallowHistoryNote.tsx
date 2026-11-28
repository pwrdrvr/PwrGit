import { useState } from "react";
import { DEEPEN_STEP, type DeepenHistoryMode, type ShallowHistory } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { showErrorToast, showInfoToast } from "../../lib/toast";

const FULL_HISTORY_TIP =
  "Download every older commit of each fetched branch. Can be a large download; afterwards history, blame and merges work without limits.";

/** What the note says about where history ends and what is missing. */
export function shallowHistorySentence(shallow: ShallowHistory): string {
  const ends =
    shallow.boundaries.length > 0
      ? "Commits older than the ones marked “history cut” weren’t downloaded."
      : "Commits older than the ones drawn here weren’t downloaded.";
  const scope =
    shallow.remote === null || shallow.fetchesOnly === null
      ? ""
      : shallow.fetchesOnly.length === 0
        ? ` ${shallow.remote}’s fetch settings name no branches, so fetching brings no other branches.`
        : ` This clone also fetches only ${shallow.fetchesOnly.join(", ")} from ${shallow.remote}, so other branches aren’t in PwrGit.`;
  const remote =
    shallow.remote === null ? " This repository has no remote to fetch them from." : "";
  return `${ends}${scope}${remote}`;
}

/**
 * The end of a shallow repository's History, and the one way to get more.
 *
 * Both buttons run `remote:deepenHistory`, a tracked fetch: the activity
 * popover shows its progress and can stop it. Nothing here runs on its own —
 * browsing History never fetches. Design: Shallow Clones - UX Review, 2–3.
 */
export function ShallowHistoryNote({
  repoId,
  repoName,
  worktreeId,
  shallow
}: {
  repoId: string;
  repoName: string;
  worktreeId: string;
  shallow: ShallowHistory;
}) {
  const tip = useViewportTooltip();
  const [running, setRunning] = useState<DeepenHistoryMode["kind"] | null>(null);
  const remote = shallow.remote;

  const run = async (mode: DeepenHistoryMode): Promise<void> => {
    if (remote === null || running !== null) return;
    setRunning(mode.kind);
    const key = `shallow-history:${repoId}`;
    try {
      const result = await dispatch("remote:deepenHistory", { repoId, worktreeId, remote, mode });
      if (!result.ok) {
        if (result.error.code === "aborted") {
          showInfoToast({ key, title: "Stopped", message: `${result.error.message} ${repoName}’s history is as it was.` });
        } else {
          showErrorToast({ key, title: "Couldn’t fetch older history", message: result.error.message, subject: { repoId } });
        }
        return;
      }
      showInfoToast({
        key,
        title: result.value.fetched ? "Fetched older history" : "Already complete",
        message: !result.value.shallow
          ? `${repoName} now has its full history.`
          : `${repoName} still has limited history: up to ${DEEPEN_STEP} more commits were fetched behind each boundary.`,
        subject: { repoId }
      });
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="graph-shallow-note" role="note" aria-label="Limited history">
      <div>
        <strong>Limited history.</strong> {shallowHistorySentence(shallow)}
      </div>
      {remote !== null && (
        <div className="graph-shallow-note__actions">
          <button
            type="button"
            disabled={running !== null}
            onClick={() => void run({ kind: "deepen", commits: DEEPEN_STEP })}
          >
            {running === "deepen" ? "Fetching older commits…" : `Fetch ${DEEPEN_STEP} older commits`}
          </button>
          <button
            type="button"
            disabled={running !== null}
            {...hoverTooltip(tip, FULL_HISTORY_TIP)}
            onClick={() => void run({ kind: "unshallow" })}
          >
            {running === "unshallow" ? "Fetching full history…" : "Fetch full history"}
          </button>
          <span>from {remote}</span>
        </div>
      )}
      {tip.tooltipNode}
    </div>
  );
}
