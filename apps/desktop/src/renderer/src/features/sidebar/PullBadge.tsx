import { useRef } from "react";
import { useStepLadder } from "../../lib/useFitLadder";
import {
  hoverTooltip,
  type ViewportTooltip
} from "../../lib/useViewportTooltip";
import { GitForkIcon } from "./RepoIdentityMarks";
import type { PullSummary } from "./repo-view";

/** A worktree row's badge steps down, never the branch name (turn 3e). */
const ROW_FIT_STEPS = ["fit-glyph", "fit-gone"] as const;

/** What the badge's card and its screen-reader text say. */
export function pullSentence(pull: PullSummary, branch: string): string {
  const commits = (n: number): string => (n === 1 ? "1 commit" : `${n} commits`);
  if (pull.kind === "tracked") {
    return `${branch} is ${commits(pull.behind)} behind its upstream`;
  }
  const own =
    pull.ahead > 0 ? `, and has ${commits(pull.ahead)} it doesn't` : "";
  // The badge counts the source only; when the fork lags too, say so here
  // rather than drop it (Post-ship 2b).
  const tracked =
    pull.trackedBehind > 0
      ? `\n${commits(pull.trackedBehind)} behind the branch it tracks`
      : "";
  return `${branch} is ${commits(pull.behind)} behind ${pull.label}, the source of this fork${own}${tracked}`;
}

/**
 * What Pull would bring in, on the repo row or a worktree row.
 *
 * Two looks for two different facts (Fork Sync, 3e rule 2): the warn fill is
 * the user's own remote having commits for them; the accent outline with the
 * fork glyph is the fork's source having them. The repo row draws the compact
 * `⑂ ↓25` only when its identity marks have no fork mark to carry the count
 * (`RepoIdentityGlyphs`' `sourcePull`). A worktree row says `↓25 upstream`,
 * then `⑂ ↓25`, then nothing, taking each step only while the branch name
 * beside it would otherwise be cut. Its `· ↑2` is the branch's own commits
 * against the source, the same count the header chip gives, and stays at
 * every step but the last.
 */
export function PullBadge({
  pull,
  branch,
  tip,
  placement
}: {
  pull: PullSummary;
  branch: string;
  tip: ViewportTooltip;
  placement: "repo" | "row";
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const row = (): HTMLElement | null =>
    ref.current?.closest<HTMLElement>(".wt-row") ?? null;
  useStepLadder(
    ref,
    () => {
      const badge = ref.current;
      const name = row()?.querySelector<HTMLElement>(".wt-row__branch");
      if (badge === null || name === null || name === undefined) return true;
      if (name.scrollWidth > name.clientWidth + 0.5) return false;
      // The row wraps its trailing badges before the name has to give; a
      // badge on a second line is not fitting either.
      if (badge.offsetParent === null) return true;
      return Math.abs(badge.offsetTop - name.offsetTop) < name.offsetHeight;
    },
    // Only the source badge steps (and holds `ref`). Keying the steps on it
    // re-runs the ladder's observer effect when a tracked badge becomes a
    // source one in place; otherwise it would never watch the row.
    placement === "row" && pull.kind === "source" ? ROW_FIT_STEPS : [],
    row
  );
  const sentence = pullSentence(pull, branch);

  if (pull.kind === "tracked") {
    return placement === "repo" ? (
      <span className="badge badge--warn" {...hoverTooltip(tip, sentence)}>
        ↓{pull.behind}
      </span>
    ) : (
      <>
        <span
          className="badge-text badge-text--warn"
          aria-hidden="true"
          {...hoverTooltip(tip, sentence)}
        >
          ↓{pull.behind}
        </span>
        <span className="a11y-sr-only">{pull.behind} behind upstream</span>
      </>
    );
  }

  const remote = pull.label.split("/")[0] ?? pull.label;
  return (
    <>
      <span
        ref={ref}
        className={`badge badge--source badge--source-${placement}`}
        aria-hidden="true"
        {...hoverTooltip(tip, sentence)}
      >
        <span className="badge--source__glyph">
          <GitForkIcon size={10} />
        </span>
        ↓{pull.behind}
        {placement === "row" && (
          <span className="badge--source__word"> {remote}</span>
        )}
        {placement === "row" && pull.ahead > 0 && ` · ↑${pull.ahead}`}
      </span>
      {placement === "row" && <span className="a11y-sr-only">{sentence}</span>}
    </>
  );
}
