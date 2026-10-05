import type { Worktree } from "@pwrgit/shared";
import { hoverTooltip, type ViewportTooltip } from "../../lib/useViewportTooltip";
import { lastSegment, worktreeFolderLabel } from "./repo-view";

/**
 * Which worktree holds a ref, and the way there: ⌂ for the primary checkout,
 * ⑂ for a linked one, then the folder. Filled when that worktree is the
 * working target, outlined when it is some other checkout.
 *
 * It names the WORKTREE, by its folder: branch and worktree are 1:1, so
 * labelling it by its branch would only repeat the row. The folder is left off
 * when it adds nothing — a directory named after the branch, or the primary
 * checkout's repo folder — and the glyph alone still says which checkout it is.
 *
 * The sidebar's branch rows and the refs browser draw the same chip, so a
 * "Show worktree" in the browser says which one, as the short list does.
 * There it fills an action slot of its own, and a glyph alone in a
 * button-sized box reads as an empty button — so it always spells the folder.
 */
export function WorktreeHolderChip({
  holder,
  here,
  subject,
  repoName,
  alwaysNameFolder = false,
  tip,
  onReveal
}: {
  holder: Worktree;
  /** The holder is the working target. */
  here: boolean;
  /** What is checked out, as the label says it: a branch name, or `#106`. */
  subject: string;
  /** A folder named after the repository adds nothing beside its header. */
  repoName: string;
  /** Spell the folder even where it repeats the branch or the repository. */
  alwaysNameFolder?: boolean;
  tip: Pick<ViewportTooltip, "show" | "hide" | "hideFrom">;
  onReveal: (worktreeId: string) => void;
}) {
  const folder = alwaysNameFolder
    ? lastSegment(holder.path)
    : worktreeFolderLabel(holder.branch, holder.path, [repoName]);
  return (
    <button
      type="button"
      className={`ref-checkout-chip${here ? " is-here" : ""}`}
      aria-label={
        here
          ? `${subject} is checked out here, in ${lastSegment(holder.path)}`
          : `Go to ${lastSegment(holder.path)}, which has ${subject} checked out`
      }
      {...hoverTooltip(tip, holder.path)}
      onClick={(event) => {
        event.stopPropagation();
        onReveal(holder.id);
      }}
    >
      <span aria-hidden="true">{holder.isPrimary ? "⌂" : "⑂"}</span>
      {folder !== null && folder !== "" && (
        <span className="ref-checkout-chip__name">{folder}</span>
      )}
    </button>
  );
}
