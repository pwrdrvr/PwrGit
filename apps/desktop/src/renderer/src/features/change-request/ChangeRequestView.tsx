import { useMemo, type ReactElement, type RefObject } from "react";
import {
  ASSUMED_FORGE_KIND,
  forgeLabel,
  type ChangeRequestEntry
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import {
  hoverTooltip,
  truncatedTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { DiffViewer } from "../diff/DiffViewer";
import type { ImageDiffRevisions } from "../diff/use-image-revisions";
import { shortWhen } from "../graph/graph-view";
import { CopyTarget } from "../shell/CopyTarget";
import { PrChip } from "../sidebar/PrChip";
import { RemoteChip } from "../sidebar/RemoteChip";
import { primaryVerb, provenanceOf, type Provenance } from "./provenance";
import type { ChangeRequestViewState } from "./useChangeRequestView";
import { WorktreeGlyph } from "../../lib/WorktreeGlyph";
import { PlusGlyph } from "../../lib/PlusGlyph";

/**
 * The PR view's main pane: the change request picked in the sidebar, read
 * with no worktree — a header drawn from the open list's cache, a line saying
 * which commit the diff is drawn to, and the diff.
 *
 * Read-only. Its verbs lead elsewhere: Go to worktree to the worktree holding
 * the head, + Worktree to New worktree, ↗ to the forge. Esc goes back to the worktree that was
 * selected before.
 *
 * Design: `design/Change Request View - UX Review.dc.html`, 2a and 3.
 */
export function ChangeRequestView({
  entry,
  state,
  manyRemotes,
  worktreeId,
  now,
  bodyRef,
  onGoToWorktree,
  onCreateWorktree,
  onClose,
  onShowRail
}: {
  /** The list row it was picked from: the header paints from it at once. */
  entry: ChangeRequestEntry;
  state: ChangeRequestViewState;
  /** More than one remote lists change requests: say which one this is. */
  manyRemotes: boolean;
  /** Any worktree of the repository, for image previews. */
  worktreeId: string | null;
  now: number;
  /** The scrolling body, so the rail's file list can bring a file into view. */
  bodyRef: RefObject<HTMLDivElement | null>;
  onGoToWorktree: (worktreeId: string) => void;
  onCreateWorktree: (entry: ChangeRequestEntry) => void;
  onClose: () => void;
  /** The rail is collapsed: the header carries its reopen control, as the
   *  worktree header does. */
  onShowRail?: () => void;
}): ReactElement {
  const tip = useViewportTooltip();
  const { view, fetching, error, scope, setScope, patch } = state;
  // The answer's entry is newer than the list's (a fetch can move the head).
  const shown = view?.entry ?? entry;
  const { pr } = shown;
  const forge = pr.forge ?? ASSUMED_FORGE_KIND;
  const verb = primaryVerb(shown);
  const ready = view?.state === "ready" ? view : null;
  // Once git answers, count what is drawn: the forge's numbers describe its
  // own head, and a local branch ahead of it changes more.
  const { totals } = state;
  const additions = totals?.additions ?? pr.additions;
  const deletions = totals?.deletions ?? pr.deletions;
  const files = totals?.files ?? pr.changedFiles;
  const commits =
    ready !== null && !ready.commitsTruncated ? ready.commits.length : pr.commitCount;
  const updatedAt = pr.updatedAt ?? pr.createdAt;
  const updated =
    updatedAt === undefined ? null : shortWhen(new Date(updatedAt).toISOString(), now);

  const images: ImageDiffRevisions | undefined = useMemo(() => {
    if (worktreeId === null || ready === null) return undefined;
    return scope.kind === "commit"
      ? {
          worktreeId,
          before: { kind: "commitParent", hash: scope.hash },
          after: { kind: "commit", hash: scope.hash }
        }
      : {
          worktreeId,
          before: { kind: "commit", hash: ready.base.mergeBase },
          after: { kind: "commit", hash: ready.head.oid }
        };
  }, [ready, scope, worktreeId]);

  const provenance: Provenance =
    fetching !== null
      ? { tone: "busy", text: `Fetching ${fetching}… Nothing gets checked out.` }
      : error !== null
        ? { tone: "bad", text: error }
        : view === null
          ? { tone: "busy", text: "Reading the diff…" }
          : provenanceOf(view);
  const toggle = provenance.toggle;

  return (
    <div
      className="cr-view"
      data-testid="change-request-view"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="cr-view__head">
        <div className="cr-view__row">
          <PrChip pr={pr} />
          <h2 className="cr-view__title" {...truncatedTooltip(tip, pr.title)}>
            {pr.title}
          </h2>
          {verb?.kind === "goto" && (
            <button
              className="wt-btn cr-view__verb"
              {...hoverTooltip(tip, "Go to the worktree with this head checked out")}
              onClick={() => onGoToWorktree(verb.worktreeId)}
            >
              <WorktreeGlyph />
              <span className="wt-btn__label">Go to worktree</span>
            </button>
          )}
          {verb?.kind === "create" && (
            <button
              className="wt-btn cr-view__verb"
              {...hoverTooltip(tip, "New worktree on this change request's head")}
              onClick={() => onCreateWorktree(shown)}
            >
              <PlusGlyph />
              <span className="wt-btn__label">Worktree</span>
            </button>
          )}
          <button
            className="wt-btn cr-view__icon"
            aria-label={`Open on ${forgeLabel(forge)}`}
            {...hoverTooltip(tip, `Open on ${forgeLabel(forge)}`)}
            onClick={() => void dispatch("shell:openExternal", { url: pr.url })}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 17 17 7" />
              <path d="M8 7h9v9" />
            </svg>
          </button>
          {onShowRail !== undefined && (
            <button className="wt-btn cr-view__icon" onClick={onShowRail} aria-label="Show panel" {...hoverTooltip(tip, "Show panel")}>
              ‹
            </button>
          )}
        </div>
        <div className="cr-view__meta">
          {pr.author !== undefined && <span className="cr-view__author">{pr.author}</span>}
          {manyRemotes && <RemoteChip remote={shown.remote} forge={forge} tip={tip} />}
          {pr.headRefName !== undefined && (
            <CopyTarget
              value={pr.headRefName}
              label={`Copy branch name ${pr.headRefName}`}
              hint={`${pr.headRefName}\nClick to copy branch name`}
              className="cr-view__ref copyable"
            >
              {pr.headRefName}
            </CopyTarget>
          )}
          {pr.baseRefName !== undefined && (
            <>
              <span aria-hidden="true">→</span>
              <span className="cr-view__ref">{pr.baseRefName}</span>
            </>
          )}
          {additions !== undefined && deletions !== undefined && (
            <span className="cr-view__stat">
              <span className="cr-view__add">+{additions}</span>
              <span className="cr-view__del">−{deletions}</span>
            </span>
          )}
          {files !== undefined && (
            <span className="cr-view__fact">
              {files} {files === 1 ? "file" : "files"}
            </span>
          )}
          {commits !== undefined && (
            <span className="cr-view__fact">
              {commits} {commits === 1 ? "commit" : "commits"}
            </span>
          )}
          {updated !== null && (
            <span className="cr-view__fact cr-view__updated">
              updated {updated}
              {updated === "just now" ? "" : " ago"}
            </span>
          )}
        </div>
        <div className={`cr-view__src is-${provenance.tone}`} role="status">
          <span className="cr-view__src-dot" aria-hidden="true" />
          <span className="cr-view__src-text">{provenance.text}</span>
          {toggle !== undefined && (
            <button className="cr-view__src-act" onClick={() => state.showEnd(toggle.show)}>
              {toggle.label}
            </button>
          )}
          {provenance.fetch !== undefined && fetching === null && (
            <button className="cr-view__src-act" onClick={state.fetchNow}>
              {provenance.fetch}
            </button>
          )}
        </div>
      </div>
      <div className="cr-view__body" ref={bodyRef}>
        {scope.kind === "commit" && (
          <div className="cr-view__scope">
            <span className="cr-view__scope-hash">{scope.hash.slice(0, 7)}</span>
            <span className="cr-view__scope-subject" {...truncatedTooltip(tip, scope.subject)}>
              {scope.subject}
            </span>
            <button className="cr-view__src-act" onClick={() => setScope({ kind: "all" })}>
              Show all changes
            </button>
          </div>
        )}
        {state.scopeError !== null ? (
          <div className="diff-empty">Couldn’t read this commit’s diff: {state.scopeError}</div>
        ) : ready !== null && patch !== null ? (
          <DiffViewer
            patch={patch}
            emptyLabel="No changes between the merge base and this head."
            {...(images === undefined ? {} : { images })}
          />
        ) : ready !== null && scope.kind === "all" && ready.patch === null ? (
          <div className="diff-empty">
            This change request is too large to draw here. Its commits are in the panel, one at a time.
          </div>
        ) : view === null || fetching !== null || (ready !== null && patch === null) ? (
          <div className="cr-view__skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>
      {tip.tooltipNode}
    </div>
  );
}
