import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import type { LocalBranchSummary, Repo, RepoRefs, Worktree } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { CopyTarget } from "../shell/CopyTarget";
import { guardedSwitchBranch } from "../shell/branchSwitch";
import {
  branchActivation,
  branchFocusState,
  branchSectionSummary,
  holderWorktreeId,
  visibleBranches as pinCurrentFirst
} from "./branch-focus";
import { lastSegment, worktreeFolderLabel } from "./repo-view";
import {
  localBranchForRemote,
  RepoRefsModal,
  trackingLabel
} from "./RepoRefsModal";

type RefSection = "branches" | "remotes";

/** How many branches the collapsed slice shows before "View all …". */
const BRANCH_SLICE = 6;

function SectionChevron({ open }: { open: boolean }) {
  return <span className={`ref-section__chev${open ? " is-open" : ""}`} />;
}

function compactTrackingLabel(tracking: ReturnType<typeof trackingLabel>): string {
  switch (tracking) {
    case "Up to date":
      return "Synced";
    case "No upstream":
      return "Local only";
    case "Upstream missing":
      return "Missing";
    default:
      return tracking;
  }
}

export function RepoRefsSections({
  repo,
  now,
  focusedWorktree,
  onRevealWorktree,
  onCreateWorktree
}: {
  repo: Repo;
  now: number;
  /** The working target, but only when it belongs to THIS repo — passing null
   *  otherwise is what keeps the current-branch marker unique across the
   *  window while "occupied" stays per-repo. */
  focusedWorktree: Worktree | null;
  onRevealWorktree: (worktreeId: string) => void;
  onCreateWorktree: (
    branch: string,
    newBranch: boolean,
    startPoint?: string
  ) => void;
}) {
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
  const remoteCount = refs?.remotes.length;
  const worktreesById = useMemo(
    () => new Map(repo.worktrees.map((w) => [w.id, w])),
    [repo.worktrees]
  );
  // The working target's branch is pinned first: the slice is short, and
  // without the pin the pairing is invisible for any branch that doesn't
  // happen to sort into the first few rows.
  const shownBranches = pinCurrentFirst(
    refs?.branches ?? [],
    focusedWorktree,
    BRANCH_SLICE
  );
  const summary = branchSectionSummary(focusedWorktree);

  /**
   * "Make this branch the one I am working on", by the cheapest safe route: a
   * branch some worktree already holds is a focus move with no git at all, and
   * only a free branch costs a checkout.
   */
  const activate = async (branch: LocalBranchSummary): Promise<void> => {
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
    const outcome = await guardedSwitchBranch({
      worktreeId: focusedWorktree.id,
      worktreeLabel: lastSegment(focusedWorktree.path),
      branch: action.branch
    });
    if (outcome.kind === "held") {
      // The refs snapshot was stale — something checked this branch out after
      // we read it. Re-list and go to whoever holds it now, which is what the
      // user asked for; only fall back to a message if it has since vanished.
      const fresh = await dispatch("repo:refs", { repoId: repo.id });
      if (fresh.ok) {
        setRefs(fresh.value);
        const held = fresh.value.branches.find((b) => b.name === action.branch);
        const holder =
          held === undefined
            ? null
            : holderWorktreeId(held, focusedWorktree.id);
        if (holder !== null) {
          onRevealWorktree(holder);
          return;
        }
      }
      showErrorToast({
        title: "Switch failed",
        message: `${action.branch} is checked out in another worktree.`
      });
      return;
    }
    if (outcome.kind === "failed") {
      showErrorToast({
        title: "Switch failed",
        message:
          outcome.code === "dirty"
            ? `${action.branch} could not be checked out without overwriting local changes. Commit or stash them first.`
            : outcome.message.split("\n")[0],
        detail: outcome.message
      });
      return;
    }
    if (outcome.kind === "switched") await load();
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
          {refs !== null && (
            <span className="ref-section__summary">
              {refs.branches.filter((branch) => branch.ahead > 0).length > 0 &&
                `↑${refs.branches.filter((branch) => branch.ahead > 0).length}`}
              {refs.branches.filter((branch) => branch.behind > 0).length > 0 &&
                ` ↓${refs.branches.filter((branch) => branch.behind > 0).length}`}
            </span>
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
                const holder =
                  holderId === null ? undefined : worktreesById.get(holderId);
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
                      title={trackingLabel(branch)}
                    >
                      {compactTrackingLabel(trackingLabel(branch))}
                    </span>
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
                        title={holder.path}
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
                      // The accessible name of a button comes from its CONTENT
                      // before its `title`, so this announced as "+" — "plus,
                      // button" (SC 4.1.2). An explicit label wins over both.
                      <button
                        className="ref-mini-action"
                        aria-label={`Create worktree for ${branch.name}`}
                        title="Create worktree"
                        onClick={(event) => {
                          event.stopPropagation();
                          onCreateWorktree(branch.name, false);
                        }}
                      >
                        <span aria-hidden="true">+</span>
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
            className={`ref-fetch-all${fetching === "*" ? " is-fetching" : ""}`}
            aria-label={`Fetch all remotes for ${repo.name}`}
            title="Fetch all remotes and prune deleted branches"
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
            ↻
          </button>
        </div>
        {openSections.has("remotes") && (
          <div className="ref-section__body">
            {refs?.remotes.map((remote) => {
              const open = openRemotes.has(remote.name);
              return (
                <div className="ref-remote" key={remote.name}>
                  <div className="ref-remote__row">
                    <button
                      className="ref-remote__main"
                      aria-expanded={open}
                      title={remote.fetchUrl}
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
                      <small>
                        {remote.name === "origin"
                          ? "default"
                          : remote.name === "upstream"
                            ? "upstream"
                            : `${remote.branchCount} refs`}
                      </small>
                    </button>
                    <button
                      className={`ref-mini-action${
                        fetching === remote.name ? " is-fetching" : ""
                      }`}
                      aria-label={`Fetch ${remote.name}`}
                      /* Busy, not unavailable — see .ref-fetch-all above. */
                      aria-disabled={fetching !== null}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (fetching !== null) return;
                        void fetchRemote(remote.name);
                      }}
                    >
                      ↻
                    </button>
                  </div>
                  {open && (
                    <div className="ref-remote__branches">
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
                            <button
                              className="ref-mini-action"
                              aria-label={
                                checkedOutId !== undefined
                                  ? `Show worktree checked out at ${branch.name}`
                                  : local !== undefined
                                    ? `Create worktree from local branch ${local.name}`
                                    : `Create a local branch and worktree from ${branch.qualifiedName}`
                              }
                              title={
                                checkedOutId !== undefined
                                  ? "Show checked-out worktree"
                                  : local !== undefined
                                    ? "Create worktree from local branch"
                                    : "Create a local branch in a new worktree"
                              }
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
                              <span aria-hidden="true">
                                {checkedOutId === undefined ? "+" : "●"}
                              </span>
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
          repo={repo}
          refs={refs}
          now={now}
          initialTab={browser}
          onRefresh={() => void load()}
          onRevealWorktree={onRevealWorktree}
          onCreateWorktree={onCreateWorktree}
          onClose={() => setBrowser(null)}
        />
      )}
    </>
  );
}
