import { CheckoutGlyph } from "../../lib/CheckoutGlyph";
import { LocateGlyph } from "../../lib/LocateGlyph";
import { PlusGlyph } from "../../lib/PlusGlyph";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from "react";
import type { TagSummary, LocalBranchSummary, Repo, RepoRefs, Worktree } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { SwitchGlyph } from "../../lib/SwitchGlyph";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { useForgeNaming } from "../../state/useForgeNaming";
import { CopyTarget } from "../shell/CopyTarget";
import { GitForkIcon, NoPushMark } from "./RepoIdentityMarks";
import { switchWorktreeToBranch } from "../shell/branchSwitch";
import {
  branchActivation,
  branchFocusState,
  branchSectionSummary,
  holderWorktreeId,
  visibleBranches as byRelevance
} from "./branch-focus";
import { remoteForgeChip } from "./forge-chip";
import { ForgeChip } from "./ForgeChip";
import { remoteUrlLines, remoteWebUrl, remoteWhere } from "./remote-info";
import { lastSegment, worktreeFolderLabel } from "./repo-view";
import {
  localBranchForRemote,
  RepoRefsModal,
  trackingLabel
} from "./RepoRefsModal";

type RefSection = "branches" | "tags" | "remotes";

/** How many branches the collapsed slice shows before "View all …". */
const BRANCH_SLICE = 6;

function SectionChevron({ open }: { open: boolean }) {
  return <span className={`ref-section__chev${open ? " is-open" : ""}`} />;
}

/**
 * The 82px-wide sidebar spelling of a branch's tracking state.
 *
 * Keyed on the STATE, not on `trackingLabel`'s prose. It used to switch on that
 * function's return value, which is typed `string` — so the case literals were
 * unchecked, and renaming one label ("Upstream missing" → "Upstream gone")
 * silently dropped the row through to the long form until the literal here was
 * chased by hand. `BranchTrackingStatus` is a union, so the compiler now
 * exhaustive-checks this and a new state cannot be forgotten.
 *
 * "Gone" is git's own word (`git branch -vv` prints `[origin/x: gone]`), and
 * the reason the row needs one: "Missing" reads as breakage while the state
 * means the upstream branch was deleted — the work landed and this branch is
 * finished.
 */
function compactTrackingLabel(branch: LocalBranchSummary): string {
  switch (branch.tracking) {
    case "up_to_date":
      return "Synced";
    case "unpublished":
      return "Local only";
    case "upstream_missing":
      return "Gone";
    case "ahead":
    case "behind":
    case "diverged":
      // The counts are the whole point of these three; `trackingLabel` already
      // renders them as ↑n / ↓n, which is compact enough as it stands.
      return trackingLabel(branch);
  }
}

export function RepoRefsSections({
  repo,
  now,
  focusedWorktree,
  onLocateTag,
  onRevealWorktree,
  onCreateWorktree,
  onFork
}: {
  repo: Repo;
  now: number;
  /** The working target, but only when it belongs to THIS repo — passing null
   *  otherwise is what keeps the current-branch marker unique across the
   *  window while "occupied" stays per-repo. */
  focusedWorktree: Worktree | null;
  onLocateTag?: ((repoId: string, tag: TagSummary) => void) | undefined;
  onRevealWorktree: (worktreeId: string) => void;
  onCreateWorktree: (
    branch: string,
    newBranch: boolean,
    startPoint?: string
  ) => void;
  /** Fork what `origin` points at and re-point this checkout at the fork. */
  onFork: () => void;
}) {
  const forgeNaming = useForgeNaming();
  /** One card for every hover surface in this tree. Native `title` is what the
   *  marks beside these rows moved off (`lib/AGENTS.md`), and two tooltip
   *  styles in one 320px column is the part a user actually notices. */
  const tip = useViewportTooltip();
  /** Asked once. The mark and the fork verb below are two renderings of this
   *  single fact, and spelling it twice is how they drift apart. */
  const cannotPush = repo.identity?.viewerCanPush === false;
  /**
   * Null whenever a chip would say nothing — one forge host on, or a remote
   * no product claims. Same gate the repo row uses, so the two surfaces cannot
   * disagree about whether forges are worth naming here.
   *
   * Both URLs, because a remote is two URLs and `remote.pushUrl` is exactly
   * how a checkout keeps a mirror on a second forge. The repo row's `+n`
   * counts every forge host on any remote, fetch or push (`readRemotes`), so
   * chipping only the fetch side left that count pointing at a host this list
   * never showed — the one place the abbreviation is supposed to be cashed in.
   * Identical URLs draw one chip, which is the ordinary case.
   */
  const forgeChipsFor = (remote: { fetchUrl: string; pushUrl: string }) => {
    if (!forgeNaming.showChips) return null;
    const urls =
      remote.pushUrl === "" || remote.pushUrl === remote.fetchUrl
        ? [remote.fetchUrl]
        : [remote.fetchUrl, remote.pushUrl];
    const chips = urls
      .map((url) => remoteForgeChip(url, forgeNaming.overrides, forgeNaming.displays))
      .filter((chip) => chip !== null);
    // Two remotes on the same forge is one chip's worth of information.
    const unique = chips.filter(
      (chip, index) => chips.findIndex((other) => other.title === chip.title) === index
    );
    return unique.map((chip) => <ForgeChip key={chip.title} chip={chip} />);
  };
  const [refs, setRefs] = useState<RepoRefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Set<RefSection>>(new Set());
  const [openRemotes, setOpenRemotes] = useState<Set<string>>(new Set());
  const [browser, setBrowser] = useState<RefSection | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  // Which branch row holds the group's single tab stop. A cursor, not a
  // selection: it carries no git meaning and no accent.
  const [branchCursor, setBranchCursor] = useState(0);
  // One activation at a time. Enter auto-repeats while held, and each repeat
  // would otherwise queue its own dirty confirm — `dialogs.ts` queues rather
  // than coalesces, so the user would be left dismissing a stack of identical
  // prompts, each accepted one dispatching another switch.
  const activating = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await dispatch("repo:refs", { repoId: repo.id });
    setLoading(false);
    if (result.ok) setRefs(result.value);
    else setError(result.error.message.split("\n")[0]);
  }, [repo.id]);

  useEffect(() => {
    void load();
  }, [load, repo]);

  const toggleSection = (section: RefSection): void => {
    setOpenSections((previous) => {
      const next = new Set(previous);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const fetchRemote = async (remote?: string): Promise<void> => {
    setFetching(remote ?? "*");
    const result = await dispatch("remote:fetchRepo", {
      repoId: repo.id,
      ...(remote === undefined ? {} : { remote })
    });
    setFetching(null);
    if (!result.ok) {
      showErrorToast({
        title: "Fetch failed",
        message: result.error.message.split("\n")[0],
        detail: result.error.message
      });
      return;
    }
    showInfoToast({
      title: remote === undefined ? "Fetched all remotes" : `Fetched ${remote}`,
      message: "Remote-tracking branches are up to date."
    });
    await load();
  };

  const branchCount = refs?.branches.length;
  const tagCount = refs?.tagCount;
  const remoteCount = refs?.remotes.length;
  const worktreesById = useMemo(
    () => new Map(repo.worktrees.map((w) => [w.id, w])),
    [repo.worktrees]
  );
  // Ranked, not sliced off the top: `repo:refs` arrives by committer date,
  // which spends a six-row budget on whatever moved last rather than on what
  // the user is working in. `branchRelevance` puts the working target's branch
  // first (the pairing is invisible otherwise), then held branches, and drops
  // branches whose upstream is gone to the bottom.
  //
  // Memoized because this component re-renders on every arrow key: the roving
  // cursor is state, and an unmemoized copy-and-sort of a 161-branch list per
  // keystroke is work whose inputs did not move.
  const shownBranches = useMemo(
    () => byRelevance(refs?.branches ?? [], focusedWorktree, BRANCH_SLICE),
    [refs?.branches, focusedWorktree]
  );
  const summary = branchSectionSummary(focusedWorktree);
  /**
   * The collapsed section's counts, in ONE pass rather than five filters.
   *
   * Assembled as parts and joined so the separators only appear between things
   * that exist — the gone count used to carry its own leading " ·", which read
   * as a dangling separator on a repository whose branches are all synced apart
   * from a couple of finished ones.
   */
  const counts = useMemo(() => {
    let ahead = 0;
    let behind = 0;
    let gone = 0;
    for (const branch of refs?.branches ?? []) {
      if (branch.ahead > 0) ahead += 1;
      if (branch.behind > 0) behind += 1;
      if (branch.tracking === "upstream_missing") gone += 1;
    }
    const parts: string[] = [];
    if (ahead > 0) parts.push(`↑${ahead}`);
    if (behind > 0) parts.push(`↓${behind}`);
    return { parts, gone };
  }, [refs?.branches]);

  /**
   * "Make this branch the one I am working on", by the cheapest safe route: a
   * branch some worktree already holds is a focus move with no git at all, and
   * only a free branch costs a checkout.
   */
  const activate = async (branch: LocalBranchSummary): Promise<void> => {
    if (activating.current) return;
    const action = branchActivation(branch, focusedWorktree);
    if (action.kind === "none") return;
    if (action.kind === "reveal") {
      onRevealWorktree(action.worktreeId);
      return;
    }
    if (focusedWorktree === null) {
      // Nothing in this repo is the working target, so there is no checkout to
      // move. Offer the branch a worktree of its own instead of silently
      // retargeting some other repo's selection.
      onCreateWorktree(branch.name, false);
      return;
    }
    activating.current = true;
    try {
      await switchTo(focusedWorktree, action.branch);
    } finally {
      activating.current = false;
    }
  };

  /** The checkout half of `activate`, split out so the in-flight flag has one
   *  obvious scope. Every branch list in the app calls the same helper, so the
   *  dirty confirm and the "held elsewhere" recovery cannot drift apart. */
  const switchTo = async (
    target: Worktree,
    branchName: string
  ): Promise<void> => {
    const outcome = await switchWorktreeToBranch({
      repoId: repo.id,
      worktreeId: target.id,
      worktreeLabel: lastSegment(target.path),
      fromBranch: target.branch,
      branch: branchName,
      onRevealWorktree,
      onRefs: setRefs
    });
    if (outcome === "switched") await load();
  };

  /**
   * The row control for "switch the working target onto this branch".
   *
   * Rendered even with nothing to move, rather than hidden: the column these
   * mini actions share stays a column, and a control whose absence is the only
   * explanation teaches nothing. A disabled button still announces its name, so
   * the reason lives in the name — a hover card is pointer-and-focus only, and
   * AT reads the label over it.
   *
   * The card says it too. Chromium does still fire hover events on a disabled
   * form control (only the click-shaped ones are suppressed), so a pointer
   * resting on the greyed-out control gets the same sentence.
   */
  const switchAction = (
    branchName: string,
    onSwitch: () => void
  ): ReactElement => (
    <button
      className="ref-mini-action ref-mini-action--switch"
      aria-label={
        focusedWorktree === null
          ? `Switch to ${branchName} — unavailable, nothing in this repository is the working target`
          : `Switch ${lastSegment(focusedWorktree.path)} to ${branchName}`
      }
      {...hoverTooltip(
        tip,
        focusedWorktree === null
          ? "Select a worktree in this repository first"
          : `Switch ${lastSegment(focusedWorktree.path)} to ${branchName}`
      )}
      disabled={focusedWorktree === null}
      onClick={(event) => {
        event.stopPropagation();
        onSwitch();
      }}
    >
      <SwitchGlyph />
    </button>
  );

  /** A remote row's switch. It shares `activate`'s in-flight flag: Enter
   *  auto-repeats, and `dialogs.ts` queues confirms rather than coalescing
   *  them, so without it a held key stacks identical prompts. */
  const switchToRemote = async (branchName: string): Promise<void> => {
    if (activating.current || focusedWorktree === null) return;
    activating.current = true;
    try {
      await switchTo(focusedWorktree, branchName);
    } finally {
      activating.current = false;
    }
  };

  /** Roving tabindex across the branch rows: one tab stop for the group, arrows
   *  to move inside it, Enter to activate — the keyboard half of double-click,
   *  without which the row would be pointer-only (SC 2.1.1). */
  const onBranchKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    index: number,
    branch: LocalBranchSummary
  ): void => {
    const move = (next: number): void => {
      event.preventDefault();
      event.stopPropagation();
      const clamped = Math.max(0, Math.min(next, shownBranches.length - 1));
      setBranchCursor(clamped);
      const rows = event.currentTarget.parentElement?.children;
      const row = rows?.[clamped];
      if (row instanceof HTMLElement) row.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(shownBranches.length - 1);
    else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void activate(branch);
    }
  };

  return (
    <>
      <div className="ref-section">
        {/* These are disclosures — they were rendering a rotating caret and no
            `aria-expanded`, so open and closed were indistinguishable to
            anything not looking at the pixels (SC 4.1.2). The Worktrees toggle
            in RepoRow already did this correctly; these two did not. */}
        <button
          className="ref-section__head"
          aria-expanded={openSections.has("branches")}
          onClick={(event) => {
            event.stopPropagation();
            toggleSection("branches");
          }}
        >
          <SectionChevron open={openSections.has("branches")} />
          <span className="ref-section__label">Branches</span>
          <span className="ref-section__count">
            {loading ? "…" : (branchCount ?? 0)}
          </span>
          {/* The pair, readable without expanding hundreds of rows — and the
              thing that makes the sidebar agree with the title bar at rest. */}
          {summary !== null && (
            <span className="ref-section__on">· {summary}</span>
          )}
          {refs !== null && counts.parts.length > 0 && (
            <span className="ref-section__summary">{counts.parts.join(" ")}</span>
          )}
          {/* Branches whose upstream was deleted. They rank last in the slice,
              so without this a repository full of finished work would say
              nothing about it at the one moment the reader could act — while
              the section is still collapsed.

              Its own element, not a third part of the summary above: that span
              is --status-warning, the tier this change argues is wrong for a
              state that means the work LANDED. Finished is not a warning. */}
          {refs !== null && counts.gone > 0 && (
            <span className="ref-section__gone">{counts.gone} gone</span>
          )}
        </button>
        {openSections.has("branches") && (
          <div className="ref-section__body">
            {/* A nested group, not bare rows: RepoRow opens ONE `role="group"`
                for the repo whose treeitems are level 2, and only treeitems and
                nested groups are valid content inside it. Without this group,
                level-3 branch rows would be a depth jump with no parent and
                would break the level-2 rows' hand-rolled posinset accounting. */}
            <div
              role="group"
              aria-label={`${repo.name} branches`}
              className="ref-branch-list"
            >
              {shownBranches.map((branch, index) => {
                const state = branchFocusState(branch, focusedWorktree);
                const holderId = holderWorktreeId(
                  branch,
                  focusedWorktree?.id ?? null
                );
                // Fall back to the working target when refs names a holder
                // the tree has not listed yet: the two are refreshed
                // independently, and without this the row briefly offers
                // "Create worktree" for a branch that IS checked out.
                const holder =
                  (holderId === null
                    ? undefined
                    : worktreesById.get(holderId)) ??
                  (state === "current" && focusedWorktree !== null
                    ? focusedWorktree
                    : undefined);
                const folderName =
                  holder === undefined
                    ? null
                    : worktreeFolderLabel(holder.branch, holder.path, [
                        repo.name
                      ]);
                return (
                  <div
                    className={`ref-branch-row is-${state}`}
                    key={branch.fullName}
                    role="treeitem"
                    aria-level={3}
                    aria-posinset={index + 1}
                    aria-setsize={shownBranches.length}
                    // The accessible half of the pairing: it survives without
                    // color, which the accent bar alone does not.
                    {...(state === "current" ? { "aria-current": true } : {})}
                    tabIndex={index === Math.min(branchCursor, shownBranches.length - 1) ? 0 : -1}
                    onFocus={() => setBranchCursor(index)}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      void activate(branch);
                    }}
                    onKeyDown={(event) => onBranchKeyDown(event, index, branch)}
                  >
                    <span className="refs-branch-icon" aria-hidden="true">⑂</span>
                    <CopyTarget
                      value={branch.name}
                      label={`Copy branch name ${branch.name}`}
                      hint={`${branch.name}\nClick to copy branch name${
                        state === "current"
                          ? ""
                          : "\nDouble-click to work on this branch"
                      }`}
                      className="ref-branch-row__name refs-copyable-name copyable"
                      // The row activates on double-click, and `dblclick`
                      // bubbles past this handler's stopPropagation — without
                      // the deferral, switching branches would also silently
                      // replace the clipboard.
                      deferForDoubleClick
                    >
                      {/* Wrapped, not bare: the wrapper is a flex box, so the name
                          needs to BE a flex item for `text-overflow` to reach it. */}
                      <span className="refs-copyable-name__text">{branch.name}</span>
                    </CopyTarget>
                    <span
                      className={`ref-branch-row__status is-${branch.tracking}`}
                      {...hoverTooltip(tip, trackingLabel(branch))}
                    >
                      {compactTrackingLabel(branch)}
                    </span>
                    {/* The verb the row already performs on double-click, given
                        a control. It was reachable only through a `title`
                        tooltip, so the one visible action on a branch row was
                        the expensive one — build a whole worktree.

                        Free rows only, matching what `branchActivation` can
                        actually do: on the current row a switch is a no-op, and
                        on an occupied one git refuses the second checkout — the
                        chip beside it already offers the answer the reader
                        wanted, which is that worktree. Rendering it anyway also
                        broke the row's own gesture: the sidebar is narrow
                        enough that a fifth control lands under the row's centre
                        point, so the first click of a DOUBLE-click activated it
                        on its own, re-ranked the list, and left the `dblclick`
                        to fire on whichever row had moved underneath. */}
                    {state === "free" &&
                      switchAction(branch.name, () => void activate(branch))}
                    {/* The chip names the WORKTREE, by its folder — branch and
                        worktree are 1:1, so labelling it by its branch would
                        only repeat the row. Where on disk is the new fact. */}
                    {holder !== undefined ? (
                      <button
                        className={`ref-checkout-chip${
                          state === "current" ? " is-here" : ""
                        }`}
                        aria-label={
                          state === "current"
                            ? `${branch.name} is checked out here, in ${lastSegment(holder.path)}`
                            : `Go to ${lastSegment(holder.path)}, which has ${branch.name} checked out`
                        }
                        {...hoverTooltip(tip, holder.path)}
                        onClick={(event) => {
                          event.stopPropagation();
                          onRevealWorktree(holder.id);
                        }}
                      >
                        <span aria-hidden="true">
                          {holder.isPrimary ? "⌂" : "⑂"}
                        </span>
                        {/* Only when the folder adds something. A directory
                            named after the branch would just repeat the row,
                            and a primary checkout's folder is the repo folder
                            the header above already shows — the glyph alone
                            still says which checkout holds this branch. */}
                        {folderName !== null && (
                          <span className="ref-checkout-chip__name">
                            {folderName}
                          </span>
                        )}
                      </button>
                    ) : (
                      // The glyph is aria-hidden, so this button has no
                      // content to name it — the label is its only name, and
                      // it has to carry the branch (SC 4.1.2). It announced as
                      // "plus, button" back when the mark was a `+` text node.
                      <button
                        className="ref-mini-action"
                        aria-label={`Create worktree for ${branch.name}`}
                        {...hoverTooltip(tip, "Create worktree")}
                        onClick={(event) => {
                          event.stopPropagation();
                          onCreateWorktree(branch.name, false);
                        }}
                      >
                        <PlusGlyph />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {error !== null && <div className="ref-section__error">{error}</div>}
            {!loading && refs !== null && refs.branches.length === 0 && (
              <div className="ref-section__empty">No local branches.</div>
            )}
            {refs !== null && refs.branches.length > 0 && (
              <button
                className="ref-view-all"
                onClick={(event) => {
                  event.stopPropagation();
                  setBrowser("branches");
                }}
              >
                View all {refs.branches.length} branches…
              </button>
            )}
          </div>
        )}
      </div>

      <div className="ref-section">
        <button
          className="ref-section__head"
          aria-expanded={openSections.has("tags")}
          onClick={(event) => {
            event.stopPropagation();
            toggleSection("tags");
          }}
        >
          <SectionChevron open={openSections.has("tags")} />
          <span className="ref-section__label">Tags</span>
          <span className="ref-section__count">
            {loading ? "…" : (tagCount ?? 0)}
          </span>
        </button>
        {openSections.has("tags") && (
          <div className="ref-section__body">
            {refs?.previewTags.map((tag) => (
              <div className="ref-tag-row" key={tag.fullName}>
                <span className="refs-tag-icon" aria-hidden="true">
                  #
                </span>
                <CopyTarget
                  value={tag.name}
                  label={`Copy tag name ${tag.name}`}
                  hint={`${tag.fullName}\nClick to copy tag name`}
                  className="refs-copyable-name copyable"
                >
                  <span className="refs-copyable-name__text">{tag.name}</span>
                </CopyTarget>
                <small
                  {...hoverTooltip(
                    tip,
                    tag.kind === "annotated"
                      ? `Annotated tag ${tag.objectId.slice(0, 12)} → ${tag.targetType} ${tag.targetId.slice(0, 12)}`
                      : `Lightweight tag → ${tag.targetType} ${tag.targetId.slice(0, 12)}`
                  )}
                >
                  {tag.targetId.slice(0, 7)}
                </small>
                {/* Last in the row, like the branch and remote-branch rows'
                    mini actions: the three lists stack in one panel, so an
                    action parked mid-row breaks the column they share.
                    Rendered only when the handler exists — a button that can
                    never do anything is worse than no button, because its
                    disabled state has no cause the reader can see. */}
                {onLocateTag !== undefined && (
                  <button
                    className="ref-mini-action"
                    /* A disabled control still announces its name, so the
                       name has to carry the reason — a card is pointer-only
                       and AT reads the label over it. The card repeats it for
                       the pointer, which a disabled control still receives. */
                    aria-label={
                      tag.targetType === "commit"
                        ? `Locate tag ${tag.name} in lineage`
                        : `Locate tag ${tag.name} in lineage — unavailable, this tag points at a ${tag.targetType}, not a commit`
                    }
                    {...hoverTooltip(
                      tip,
                      tag.targetType === "commit"
                        ? "Locate tag in lineage"
                        : `This tag points at a ${tag.targetType}, not a commit`
                    )}
                    disabled={tag.targetType !== "commit"}
                    onClick={(event) => {
                      event.stopPropagation();
                      onLocateTag(repo.id, tag);
                    }}
                  >
                    <LocateGlyph />
                  </button>
                )}
              </div>
            ))}
            {error !== null && <div className="ref-section__error">{error}</div>}
            {!loading && refs !== null && refs.tagCount === 0 && (
              <div className="ref-section__empty">No local tags.</div>
            )}
            {refs !== null && refs.tagCount > 0 && (
              <button
                className="ref-view-all"
                onClick={(event) => {
                  event.stopPropagation();
                  setBrowser("tags");
                }}
              >
                View all {refs.tagCount} tags…
              </button>
            )}
            {/* With no tags at all there is nothing to browse, but there is
                still something to do — the browser is where Create tag lives. */}
            {!loading && refs !== null && refs.tagCount === 0 && (
              <button
                className="ref-view-all"
                onClick={(event) => {
                  event.stopPropagation();
                  setBrowser("tags");
                }}
              >
                Create a tag…
              </button>
            )}
          </div>
        )}
      </div>

      <div className="ref-section">
        <div className="ref-section__head-wrap">
          <button
            className="ref-section__head"
            aria-expanded={openSections.has("remotes")}
            onClick={(event) => {
              event.stopPropagation();
              toggleSection("remotes");
            }}
          >
            <SectionChevron open={openSections.has("remotes")} />
            <span className="ref-section__label">Remotes</span>
            <span className="ref-section__count">
              {loading ? "…" : (remoteCount ?? 0)}
            </span>
          </button>
          <button
            className="ref-fetch-all"
            aria-label={`Fetch all remotes for ${repo.name}`}
            aria-busy={fetching === "*"}
            {...hoverTooltip(tip, "Fetch all remotes and prune deleted branches")}
            /* `disabled` stays for the static case (there is nothing to fetch),
               but NOT for the in-flight one: Chromium blurs an element the
               moment it becomes disabled, so a fetch started from the keyboard
               threw focus to <body> until it returned (SC 2.4.3). Busy is
               aria-disabled, which says the same thing and keeps the button
               focusable — same fix as .wt-refresh in RepoRow. */
            disabled={(refs?.remotes.length ?? 0) === 0}
            aria-disabled={fetching !== null || (refs?.remotes.length ?? 0) === 0}
            onClick={(event) => {
              event.stopPropagation();
              if (fetching !== null) return;
              void fetchRemote();
            }}
          >
            <RefreshGlyph />
          </button>
        </div>
        {openSections.has("remotes") && (
          <div className="ref-section__body">
            {refs?.remotes.map((remote) => {
              const open = openRemotes.has(remote.name);
              // Where it lives, said in words rather than left for the user to
              // read out of a URL. The `title` this replaces was the raw fetch
              // URL and rendered as the OS tooltip, two styles away from every
              // other card in this column.
              const where = remoteWhere(remote.fetchUrl);
              const webUrl = remoteWebUrl(remote.fetchUrl, forgeNaming.overrides);
              const urlLines = remoteUrlLines(remote);
              return (
                <div className="ref-remote" key={remote.name}>
                  <div className="ref-remote__row">
                    <button
                      className="ref-remote__main"
                      aria-expanded={open}
                      {...hoverTooltip(
                        tip,
                        <span className="ref-remote__tip">
                          <strong>{where}</strong>
                          {urlLines.map((line) => (
                            <span key={line.label}>
                              {urlLines.length > 1 && `${line.label}: `}
                              {line.url}
                            </span>
                          ))}
                        </span>
                      )}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenRemotes((previous) => {
                          const next = new Set(previous);
                          if (next.has(remote.name)) next.delete(remote.name);
                          else next.add(remote.name);
                          return next;
                        });
                      }}
                    >
                      <SectionChevron open={open} />
                      <span>{remote.name}</span>
                      {/* Per remote, because the repo row above can only
                          carry a count: this is where a checkout that pushes
                          to one forge and mirrors to another says which is
                          which. Silent for a remote no product claims. */}
                      {forgeChipsFor(remote)}
                      {/* The read-only fact belongs to a REMOTE, and this is
                          the remote it is about — `origin` is what `git push`
                          uses and what the repo row's mark is really saying.
                          Only here: `upstream` being unwritable is the normal
                          shape of a fork, not news. */}
                      {remote.name === "origin" &&
                        repo.identity !== undefined && (
                          <NoPushMark
                            identity={repo.identity}
                            size={11}
                            // Inside this button, so its words would be spliced
                            // into the button's own name. The fork control
                            // beside it is where they are said out loud.
                            decorative
                          />
                        )}
                      <small>
                        {remote.name === "origin"
                          ? "default"
                          : remote.name === "upstream"
                            ? "upstream"
                            : `${remote.branchCount} refs`}
                      </small>
                    </button>
                    {/* A direct action rather than a menu holding one item.
                        Offered whenever this checkout cannot push, without
                        first asking the forge whether a fork already exists:
                        that answer costs a round trip per row, and the dialog
                        resolves it anyway — it says "Switch origin to my fork"
                        instead of "Fork" when the fork is already there. */}
                    {remote.name === "origin" && cannotPush && (
                      <button
                        type="button"
                        className="ref-mini-action ref-mini-action--fork"
                        // The constraint and the verb in one name: the mark
                        // beside it is `aria-hidden` inside the disclosure
                        // button, so this is where the fact is said out loud.
                        aria-label={`You can't push to ${repo.identity?.nameWithOwner ?? remote.name}. Fork it and point origin at your fork`}
                        {...hoverTooltip(
                          tip,
                          `Fork ${repo.identity?.nameWithOwner ?? remote.name} — origin moves to your copy, the original is kept as upstream`
                        )}
                        onClick={(event) => {
                          event.stopPropagation();
                          tip.hide();
                          onFork();
                        }}
                      >
                        <GitForkIcon size={12} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="ref-mini-action"
                      aria-label={`Fetch ${remote.name}`}
                      aria-busy={fetching === remote.name}
                      {...hoverTooltip(tip, `Fetch ${remote.name} and prune deleted branches`)}
                      /* Busy, not unavailable — see .ref-fetch-all above. */
                      aria-disabled={fetching !== null}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (fetching !== null) return;
                        void fetchRemote(remote.name);
                      }}
                    >
                      <RefreshGlyph />
                    </button>
                  </div>
                  {open && (
                    <div className="ref-remote__branches">
                      {/* What the remote actually IS, before the refs it
                          carries. Expanding a remote used to jump straight to
                          branch names, so the two things a person opens a
                          remote to check — how git reaches it, and the URL
                          that is configured — were nowhere on screen: the URL
                          lived only in a `title` on the row above, which is
                          the OS tooltip rather than one of ours. */}
                      <div className="ref-remote__info">
                        {/* Wire and web link share the line: both are one
                            short phrase, and the link repeated on its own row
                            per remote reads louder than the refs below it. */}
                        <div className="ref-remote__info-head">
                          <span className="ref-remote__wire">{where}</span>
                          {webUrl !== null && (
                            <button
                              type="button"
                              className="ref-remote__open"
                              {...hoverTooltip(tip, `Open ${webUrl}`)}
                              onClick={(event) => {
                                event.stopPropagation();
                                tip.hide();
                                void dispatch("shell:openExternal", {
                                  url: webUrl
                                });
                              }}
                            >
                              Open on the web
                            </button>
                          )}
                        </div>
                        {urlLines.map((line) => (
                          <span className="ref-remote__url" key={line.label}>
                            {urlLines.length > 1 && (
                              <span className="ref-remote__url-label">
                                {line.label}
                              </span>
                            )}
                            {/* Copyable rather than selectable: this is the
                                string people paste into a terminal, and a
                                sidebar row is a bad place to drag-select. */}
                            <CopyTarget
                              value={line.url}
                              label={`${remote.name} ${line.label.toLowerCase()} URL`}
                            >
                              <span className="ref-remote__url-text">
                                {line.url}
                              </span>
                            </CopyTarget>
                          </span>
                        ))}
                      </div>
                      {remote.previewBranches.map((branch) => {
                        const local = localBranchForRemote(refs, branch);
                        const checkedOutId = local?.checkedOutWorktreeIds[0];
                        return (
                          <div
                            className="ref-remote-branch-row"
                            key={branch.fullName}
                          >
                            <span className="refs-branch-icon" aria-hidden="true">⑂</span>
                            <CopyTarget
                              value={branch.name}
                              label={`Copy branch name ${branch.name}`}
                              hint={`${branch.qualifiedName}\nClick to copy branch name`}
                              className="refs-copyable-name copyable"
                            >
                              <span className="refs-copyable-name__text">
                                {branch.name}
                              </span>
                            </CopyTarget>
                            {branch.name === remote.defaultBranch && (
                              <small>default</small>
                            )}
                            {/* A fetched branch with no local counterpart is
                                exactly the case "switch me to it" is for, and
                                it was the one row in the app with no switch at
                                all. `git switch <short name>` DWIMs the local
                                tracking branch into existence, so this costs a
                                checkout and no directory. A branch some
                                worktree already holds resolves to that
                                worktree instead — see `switchWorktreeToBranch`. */}
                            {checkedOutId === undefined &&
                              switchAction(branch.name, () =>
                                void switchToRemote(branch.name)
                              )}
                            <button
                              className="ref-mini-action"
                              aria-label={
                                checkedOutId !== undefined
                                  ? `Show worktree checked out at ${branch.name}`
                                  : local !== undefined
                                    ? `Create worktree from local branch ${local.name}`
                                    : `Create a local branch and worktree from ${branch.qualifiedName}`
                              }
                              {...hoverTooltip(
                                tip,
                                checkedOutId !== undefined
                                  ? "Show checked-out worktree"
                                  : local !== undefined
                                    ? "Create worktree from local branch"
                                    : "Create a local branch in a new worktree"
                              )}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (checkedOutId !== undefined) {
                                  onRevealWorktree(checkedOutId);
                                } else if (local !== undefined) {
                                  onCreateWorktree(local.name, false);
                                } else {
                                  onCreateWorktree(
                                    branch.name,
                                    true,
                                    branch.fullName
                                  );
                                }
                              }}
                            >
                              {checkedOutId === undefined ? (
                                <PlusGlyph />
                              ) : (
                                /* The graph's ref chips draw this same house
                                   for "checked out in a worktree", and this
                                   button opens that worktree. */
                                <CheckoutGlyph />
                              )}
                            </button>
                          </div>
                        );
                      })}
                      {remote.branchCount === 0 && (
                        <div className="ref-section__empty">No fetched branches.</div>
                      )}
                      {/* The preview is the newest handful, not the whole
                          remote — say so, rather than letting six rows read as
                          "this remote has six branches". */}
                      {remote.branchCount > remote.previewBranches.length && (
                        <button
                          className="ref-view-all"
                          onClick={(event) => {
                            event.stopPropagation();
                            setBrowser("remotes");
                          }}
                        >
                          View all {remote.branchCount} branches on {remote.name}…
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {error !== null && <div className="ref-section__error">{error}</div>}
            {!loading && refs !== null && refs.remotes.length === 0 && (
              <div className="ref-section__empty">No remotes configured.</div>
            )}
            {refs !== null && (
              <button
                className="ref-view-all"
                onClick={(event) => {
                  event.stopPropagation();
                  setBrowser("remotes");
                }}
              >
                Manage remotes and remote branches…
              </button>
            )}
          </div>
        )}
      </div>

      {browser !== null && refs !== null && (
        <RepoRefsModal
          onLocateTag={onLocateTag}
          repo={repo}
          refs={refs}
          focusedWorktree={focusedWorktree}
          now={now}
          initialTab={browser}
          onRefresh={load}
          onRevealWorktree={onRevealWorktree}
          onCreateWorktree={onCreateWorktree}
          onClose={() => setBrowser(null)}
        />
      )}
      {tip.tooltipNode}
    </>
  );
}
