import { LocateGlyph } from "../../lib/LocateGlyph";
import { useEffect, useMemo, useState } from "react";
import {
  changeRequestMatch,
  changeRequestNoun,
  changeRequestNumberQuery,
  changeRequestPluralLabel,
  changeRequestSigil,
  type ForgeKind,
  type LocalBranchSummary,
  type PrSummary,
  type RemoteBranchSummary,
  type RemoteSummary,
  type Repo,
  type RepoRefs,
  type TagSummary,
  type Worktree
} from "@pwrgit/shared";
import { shortWhen } from "../graph/graph-view";
import { switchWorktreeToBranch } from "../shell/branchSwitch";
import { confirmDialog } from "../shell/dialogs";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { useTagSearch } from "../../lib/useTagSearch";
import {
  useRemoteBranchSearch,
  type RemoteBranchSearch
} from "../../lib/useRemoteBranchSearch";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { CopyTarget } from "../shell/CopyTarget";
import { lastSegment } from "./repo-view";
import { BranchRenameDialog } from "./BranchRenameDialog";
import { PushRefsDialog } from "./PushRefsDialog";
import { CreateTagDialog } from "./CreateTagDialog";
import { RemoteEditorDialog } from "./RemoteEditorDialog";
import { TagRemoteDialog } from "./TagRemoteDialog";
import { PrChip } from "./PrChip";
import {
  ChangeRequestTable,
  filterChangeRequests,
  useChangeRequestList,
  useChangeRequestLookup
} from "./RepoChangeRequests";

export function trackingLabel(branch: LocalBranchSummary): string {
  switch (branch.tracking) {
    case "up_to_date":
      return "Up to date";
    case "ahead":
      return `↑${branch.ahead}`;
    case "behind":
      return `↓${branch.behind}`;
    case "diverged":
      return `↑${branch.ahead} ↓${branch.behind}`;
    case "unpublished":
      return "No upstream";
    case "upstream_missing":
      // Git's word — `git branch -vv` prints `[origin/x: gone]`. "Missing"
      // reads as breakage; this state means the branch landed and its remote
      // was deleted. The sidebar's compact column says just "Gone".
      return "Upstream gone";
  }
}

/** What a local branch row's own filter reads. */
function localBranchText(branch: LocalBranchSummary): string {
  return `${branch.name} ${branch.upstream ?? ""} ${branch.subject ?? ""}`;
}

export function localBranchForRemote(
  refs: RepoRefs,
  branch: RemoteBranchSummary
): LocalBranchSummary | undefined {
  return refs.branches.find((candidate) => candidate.name === branch.name);
}

type BrowserBranch =
  | { kind: "local"; branch: LocalBranchSummary }
  | { kind: "remote"; branch: RemoteBranchSummary };

export type RefsTab = "branches" | "tags" | "remotes" | "changeRequests";

/**
 * Whether a branch row is on screen because of its change request rather than
 * its own text — the row then says so, with the PR's title where the commit
 * subject would be, so the reader can see why `106` found `codex/console-…`.
 */
export function matchedViaChangeRequest(
  text: string,
  pr: PrSummary | undefined,
  query: string
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "" || pr === undefined) return false;
  if (changeRequestMatch(pr, query) === null) return false;
  // A number query names the PR even when the digits also appear in the
  // branch name: `106` is asking for #106, not for `issue-1060`.
  return (
    changeRequestNumberQuery(query) !== null ||
    !text.toLowerCase().includes(needle)
  );
}

/** The footer's "why these rows": `matched on pull request #106`. */
function viaPrNote(forge: ForgeKind, query: string): string {
  const number = changeRequestNumberQuery(query);
  const noun = changeRequestNoun(forge);
  return number === null
    ? `some matched on their ${noun}`
    : `matched on ${noun} ${changeRequestSigil(forge)}${number}`;
}

/** Branch-row identity: name, its PR's chip, and the line under it. */
function BranchIdentity({
  name,
  hint,
  subject,
  pr,
  matchedText,
  query
}: {
  name: string;
  hint: string;
  subject: string | undefined;
  pr: PrSummary | undefined;
  /** The text the row's own filter matches, to tell a PR match apart. */
  matchedText: string;
  query: string;
}) {
  const viaPr = matchedViaChangeRequest(matchedText, pr, query);
  const second = viaPr && pr !== undefined ? pr.title : subject;
  return (
    <div className="refs-table__identity">
      <span className="refs-branch-icon" aria-hidden="true">⑂</span>
      <div>
        <span className="refs-branch-name-line">
          <CopyTarget
            value={name}
            label={`Copy branch name ${name}`}
            hint={hint}
            className="refs-copyable-name copyable"
          >
            <strong>{name}</strong>
          </CopyTarget>
          {pr !== undefined && <PrChip pr={pr} />}
        </span>
        {second !== undefined && (
          <small className={viaPr ? "refs-branch-via-pr" : undefined}>
            {second}
          </small>
        )}
      </div>
    </div>
  );
}

/**
 * "Move the working target onto this branch" — the verb this browser was
 * missing entirely.
 *
 * It is the PRIMARY action on every branch row and the leftmost, because it is
 * the cheap, reversible, overwhelmingly common answer to "put me on that
 * branch". Creating a worktree — which writes a directory the user then has to
 * remember to remove — used to be the only one offered, and every row's buttons
 * were painted at the same weight; the rest are `--quiet` now so this one reads
 * as the default and `Delete` stops looking like a primary action.
 *
 * "Here" is the working target, the checkout every other git verb in the window
 * aims at. With none in this repository there is nothing to move, so the button
 * is genuinely `disabled` — and carries its reason in the accessible NAME,
 * since a disabled control still announces its name and AT reads that over a
 * `title`.
 */
function SwitchHereButton({
  branch,
  worktree,
  rowKey,
  inFlight,
  onSwitch
}: {
  branch: string;
  /** The working target, or null when this repository holds none. */
  worktree: Worktree | null;
  /** Identifies THIS row's switch. The bare branch name is not enough: two
   *  remotes can both carry `feature/x`, and keying on the name lit up
   *  "Switching…" on a row that was not acting. */
  rowKey: string;
  /** The `rowKey` of the switch currently running, or null. */
  inFlight: string | null;
  onSwitch: () => void;
}) {
  const tip = useViewportTooltip();
  const busy = inFlight === rowKey;
  // Only one switch runs at a time — `switchHere` refuses a second outright.
  // Without saying so, every other row stayed enabled and swallowed its click
  // silently: no toast, no spinner, nothing. `aria-disabled` rather than
  // `disabled`, per styles/AGENTS.md, so a keyboard user is not blurred
  // mid-operation; the handler does the refusing.
  const blocked = inFlight !== null && !busy;
  const label =
    worktree === null
      ? `Switch to ${branch} — unavailable, nothing in this repository is the working target`
      : `Switch ${lastSegment(worktree.path)} to ${branch}`;
  return (
    <button
      className="refs-row-action"
      aria-label={label}
      {...hoverTooltip(
        tip,
        worktree === null
          ? "Select a worktree in this repository first"
          : label
      )}
      disabled={worktree === null}
      aria-disabled={busy || blocked}
      onClick={() => {
        if (busy || blocked) return;
        onSwitch();
      }}
    >
      {busy ? "Switching…" : "Switch here"}
      {tip.tooltipNode}
    </button>
  );
}

/**
 * "Showing X of Y" plus the control that extends the page.
 *
 * Silent truncation is the failure mode worth designing against here: a list
 * that stops at 50 of 4,466 with no marker reads as the whole remote.
 */
function RefsPageFooter({
  shown,
  total,
  search,
  noun = "branches",
  note
}: {
  shown: number;
  total: number;
  search: Pick<
    RemoteBranchSearch,
    "error" | "loading" | "hasMore" | "loadMore"
  >;
  noun?: string;
  /** Why some rows matched, when it is not the obvious reason. */
  note?: string | undefined;
}) {
  if (search.error !== null) {
    return <div className="refs-page-footer is-error">{search.error}</div>;
  }
  if (search.loading && shown === 0) {
    return <div className="refs-page-footer">Loading {noun}…</div>;
  }
  if (total === 0) return null;
  return (
    <div className="refs-page-footer">
      <span>
        Showing {shown} of {total}
        {note === undefined ? "" : ` · ${note}`}
      </span>
      {search.hasMore && (
        <button
          className="refs-row-action"
          disabled={search.loading}
          onClick={() => search.loadMore()}
        >
          {search.loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

/** One remote's branches, paged rather than listed whole. */
function RemoteBranchList({
  repoId,
  remote,
  query,
  now,
  refs,
  focusedWorktree,
  switching,
  onSwitch,
  onPick
}: {
  repoId: string;
  remote: string;
  query: string;
  now: number;
  refs: RepoRefs;
  focusedWorktree: Worktree | null;
  /** The `fullName` of the row whose switch is running, or null. */
  switching: string | null;
  onSwitch: (rowKey: string, branch: string) => void;
  onPick: (branch: RemoteBranchSummary) => void;
}) {
  const search = useRemoteBranchSearch({ repoId, remote, query });
  return (
    <div className="refs-remote-branches">
      {search.rows.map((branch) => {
        const local = localBranchForRemote(refs, branch);
        const checkedOut = (local?.checkedOutWorktreeIds.length ?? 0) > 0;
        return (
          <div className="refs-remote-branch" key={branch.fullName}>
            <span className="refs-branch-icon" aria-hidden="true">⑂</span>
            <div>
              <span className="refs-branch-name-line">
                <CopyTarget
                  value={branch.name}
                  label={`Copy branch name ${branch.name}`}
                  hint={`${branch.qualifiedName}\nClick to copy branch name`}
                  className="refs-copyable-name copyable"
                >
                  <strong>{branch.name}</strong>
                </CopyTarget>
                {branch.pr !== undefined && <PrChip pr={branch.pr} />}
              </span>
              {branch.subject !== undefined && <small>{branch.subject}</small>}
            </div>
            <span className="refs-table__muted">
              {branch.lastCommitAt === undefined
                ? "—"
                : shortWhen(branch.lastCommitAt, now)}
            </span>
            <div className="refs-row-actions">
              {/* A branch a worktree already holds is a navigation problem, not
                  a checkout one — git refuses the second checkout anyway, so
                  the row offers the worktree instead of a switch that cannot
                  succeed. */}
              {!checkedOut && (
                <SwitchHereButton
                  branch={branch.name}
                  worktree={focusedWorktree}
                  rowKey={branch.fullName}
                  inFlight={switching}
                  onSwitch={() => onSwitch(branch.fullName, branch.name)}
                />
              )}
              <button
                className={`refs-row-action${checkedOut ? "" : " refs-row-action--quiet"}`}
                onClick={() => onPick(branch)}
              >
                {checkedOut ? "Show worktree" : "New worktree"}
              </button>
            </div>
          </div>
        );
      })}
      {search.total === 0 && !search.loading && (
        <div className="refs-browser__empty">
          No fetched branches match this filter.
        </div>
      )}
      <RefsPageFooter
        shown={search.rows.length}
        total={search.total}
        search={search}
      />
    </div>
  );
}

export function RepoRefsModal({
  repo,
  refs,
  focusedWorktree,
  now,
  initialTab,
  onRefresh,
  onLocateTag,
  onRevealWorktree,
  onCreateWorktree,
  onClose
}: {
  repo: Repo;
  refs: RepoRefs;
  /** The working target, but only when it belongs to THIS repo — the checkout
   *  "Switch here" moves. Null leaves every switch control disabled with its
   *  reason in the label, rather than silently absent. */
  focusedWorktree: Worktree | null;
  now: number;
  initialTab: RefsTab;
  onRefresh: () => void | Promise<void>;
  onLocateTag?: ((repoId: string, tag: TagSummary) => void) | undefined;
  onRevealWorktree: (worktreeId: string) => void;
  onCreateWorktree: (
    branch: string,
    newBranch: boolean,
    startPoint?: string
  ) => void;
  onClose: () => void;
}) {
  const tip = useViewportTooltip();
  const [tab, setTab] = useState<RefsTab>(initialTab);
  const [query, setQuery] = useState("");
  const [pushOpen, setPushOpen] = useState(false);
  const [createTagOpen, setCreateTagOpen] = useState(false);
  const [remoteTag, setRemoteTag] = useState<TagSummary | null>(null);
  const [tagEpoch, setTagEpoch] = useState(0);
  const [remoteEditor, setRemoteEditor] = useState<RemoteSummary | "new" | null>(
    null
  );
  const [renaming, setRenaming] = useState<LocalBranchSummary | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  // Locals arrive whole on `repo:refs` and are bounded in practice, so they
  // still filter here. Remote branches are not: they page in from main.
  // A branch also answers to its change request's number and title.
  const localMatches = useMemo<BrowserBranch[]>(() => {
    const matched = refs.branches.filter(
      (branch) =>
        q === "" ||
        localBranchText(branch).toLowerCase().includes(q) ||
        (branch.pr !== undefined && changeRequestMatch(branch.pr, q) !== null)
    );
    return matched.map((branch) => ({ kind: "local" as const, branch }));
  }, [q, refs.branches]);
  const localNames = useMemo(
    () => new Set(refs.branches.map((branch) => branch.name)),
    [refs.branches]
  );
  // With a query typed, every tab reports its own match count, so these run
  // for the tab counts even while another tab is showing.
  const counting = q !== "";
  const remoteSearch = useRemoteBranchSearch({
    repoId: repo.id,
    query,
    enabled: tab === "branches" || tab === "remotes" || counting
  });
  const tagSearch = useTagSearch({
    repoId: repo.id,
    query,
    enabled: tab === "tags" || counting,
    refreshKey: tagEpoch
  });
  const changeRequests = useChangeRequestList(repo.id);
  const forge = changeRequests.list?.forge ?? null;
  const lookup = useChangeRequestLookup({
    repoId: repo.id,
    query,
    list: changeRequests.list,
    enabled: forge !== null
  });
  const changeRequestMatches = useMemo(
    () =>
      changeRequests.list === null
        ? []
        : filterChangeRequests(changeRequests.list.entries, query),
    [changeRequests.list, query]
  );
  // A tab whose forge went away (origin re-pointed) has nothing to show.
  const shownTab: RefsTab =
    tab === "changeRequests" && forge === null ? "branches" : tab;
  // A remote branch that shadows a local one is still one branch to the user,
  // so it is dropped — per page, since that is the scope we have.
  const remoteMatches = useMemo<BrowserBranch[]>(
    () =>
      remoteSearch.rows
        .filter((branch) => !localNames.has(branch.name))
        .map((branch) => ({ kind: "remote" as const, branch })),
    [localNames, remoteSearch.rows]
  );
  // Locals list above remotes, except that the branch whose change request
  // the query names by number leads — `106` is asking for #106's branch, not
  // for `issue-10604`, wherever each of them lives.
  const branches = useMemo(() => {
    const all = [...localMatches, ...remoteMatches];
    const number = changeRequestNumberQuery(q);
    if (number === null) return all;
    const named = (item: BrowserBranch): number =>
      item.branch.pr?.number === number ? 0 : 1;
    return all.sort((a, b) => named(a) - named(b));
  }, [localMatches, q, remoteMatches]);
  const branchTabCount =
    refs.branches.length +
    refs.remotes.reduce((total, remote) => total + remote.branchCount, 0);
  const lookupHit =
    lookup.state === "done" && lookup.entry !== null ? 1 : 0;
  const tabCounts: Record<RefsTab, number> = counting
    ? {
        branches: localMatches.length + remoteMatches.length,
        tags: tagSearch.total,
        remotes: remoteSearch.total,
        changeRequests: changeRequestMatches.length + lookupHit
      }
    : {
        branches: branchTabCount,
        tags: refs.tagCount,
        remotes: refs.remotes.length,
        changeRequests: changeRequests.list?.entries.length ?? 0
      };
  // Under a query the counts are hit counts: a tab with hits takes the
  // accent and an empty one dims, so nobody has to guess where to look.
  // Nothing is claimed while a count is still loading.
  const tabCountLoading: Record<RefsTab, boolean> = {
    branches: remoteSearch.loading,
    tags: tagSearch.loading,
    remotes: remoteSearch.loading,
    changeRequests: changeRequests.list === null || lookup.state === "loading"
  };
  const tabClass = (value: RefsTab): string =>
    [
      shownTab === value ? "is-active" : "",
      counting && !tabCountLoading[value]
        ? tabCounts[value] > 0
          ? "has-hits"
          : "is-empty"
        : ""
    ]
      .filter(Boolean)
      .join(" ");
  const branchesMatchedViaPr =
    counting &&
    branches.some((item) =>
      matchedViaChangeRequest(
        item.kind === "local"
          ? localBranchText(item.branch)
          : `${item.branch.qualifiedName} ${item.branch.subject ?? ""}`,
        item.branch.pr,
        query
      )
    );

  /**
   * Move the working target onto `branchName`, through the one helper every
   * branch surface shares — so the dirty confirm, and the recovery when another
   * worktree grabbed the branch after this snapshot was read, behave here
   * exactly as they do in the sidebar and the lineage graph.
   *
   * The dialog stays open on success. The reader came here to browse branches
   * and frequently has more to do; the row's own state (and the refreshed
   * snapshot behind it) is what confirms the switch landed. Revealing a
   * worktree is a navigation, so that one closes.
   */
  const switchHere = async (
    rowKey: string,
    branchName: string
  ): Promise<void> => {
    if (switching !== null || focusedWorktree === null) return;
    setSwitching(rowKey);
    const outcome = await switchWorktreeToBranch({
      repoId: repo.id,
      worktreeId: focusedWorktree.id,
      worktreeLabel: lastSegment(focusedWorktree.path),
      fromBranch: focusedWorktree.branch,
      branch: branchName,
      onRevealWorktree
    });
    setSwitching(null);
    if (outcome === "revealed") {
      onClose();
      return;
    }
    if (outcome === "switched") await onRefresh();
  };

  const createRemoteWorktree = (branch: RemoteBranchSummary): void => {
    const local = localBranchForRemote(refs, branch);
    const checkedOutId = local?.checkedOutWorktreeIds[0];
    if (checkedOutId !== undefined) onRevealWorktree(checkedOutId);
    else if (local !== undefined) onCreateWorktree(local.name, false);
    else onCreateWorktree(branch.name, true, branch.fullName);
    onClose();
  };

  const tagsChanged = (): void => {
    setTagEpoch((value) => value + 1);
    onRefresh();
  };

  const deleteLocalTag = async (tag: TagSummary): Promise<void> => {
    if (deletingTag !== null) return;
    const confirmed = await confirmDialog({
      title: `Delete local tag ${tag.name}?`,
      message: `This deletes only local ${tag.fullName} at ${tag.objectId.slice(0, 12)}. Tags on remotes are unchanged.`,
      confirmLabel: "Delete local tag",
      danger: true
    });
    if (!confirmed) return;
    setDeletingTag(tag.name);
    const result = await dispatch("tag:deleteLocal", {
      repoId: repo.id,
      name: tag.name,
      expectedObjectId: tag.objectId
    });
    setDeletingTag(null);
    if (!result.ok) {
      showErrorToast({
        title: "Delete tag failed",
        message: result.error.message.split("\n")[0],
        detail: result.error.message
      });
      return;
    }
    tagsChanged();
  };

  const removeRemote = async (remote: RemoteSummary): Promise<void> => {
    const confirmed = await confirmDialog({
      title: `Remove remote ${remote.name}?`,
      message:
        "This removes the remote configuration and its fetched remote-tracking branches. The remote repository itself is not deleted.",
      confirmLabel: "Remove remote",
      danger: true
    });
    if (!confirmed) return;
    const result = await dispatch("remote:remove", {
      repoId: repo.id,
      remote: remote.name
    });
    if (!result.ok) {
      showErrorToast({
        title: "Remove remote failed",
        message: result.error.message.split("\n")[0],
        detail: result.error.message
      });
      return;
    }
    onRefresh();
  };

  const reportDeleteFailure = async (message: string): Promise<void> => {
    showErrorToast({
      title: "Delete branch failed",
      message: message.split("\n")[0] ?? message,
      detail: message
    });
    // Occupancy and expected-tip failures mean the browser snapshot is stale.
    // Refresh on every failure: it is cheap for locals and avoids special-case
    // drift between the action labels and main's live Git view.
    await onRefresh();
  };

  const deleteBranch = async (branch: LocalBranchSummary): Promise<void> => {
    if (deleting !== null) return;
    const confirmed = await confirmDialog({
      title: `Delete local branch ${branch.name}?`,
      message:
        "Git will delete this local branch only if its commits are merged into its upstream (or the current history when it has no upstream). No remote branch is changed.",
      confirmLabel: "Delete branch",
      danger: true
    });
    if (!confirmed) return;

    setDeleting(branch.name);
    const result = await dispatch("branch:delete", {
      repoId: repo.id,
      branch: branch.name,
      expectedHead: branch.head
    });
    setDeleting(null);
    if (result.ok) {
      showInfoToast({
        title: "Branch deleted",
        message: `${branch.name} was deleted locally. No remote branch was changed.`
      });
      await onRefresh();
      return;
    }
    if (result.error.code !== "unmerged") {
      await reportDeleteFailure(result.error.message);
      return;
    }

    const forced = await confirmDialog({
      title: `Force delete ${branch.name}?`,
      message:
        "Git cannot confirm that this branch's commits are merged. Force deletion can make commits unique to this local branch difficult to recover.\n\nOnly the local branch is deleted. No remote branch is changed.",
      confirmLabel: "Force delete branch",
      danger: true
    });
    if (!forced) return;

    setDeleting(branch.name);
    const forcedResult = await dispatch("branch:delete", {
      repoId: repo.id,
      branch: branch.name,
      expectedHead: branch.head,
      force: true
    });
    setDeleting(null);
    if (!forcedResult.ok) {
      await reportDeleteFailure(forcedResult.error.message);
      return;
    }
    showInfoToast({
      title: "Branch force-deleted",
      message: `${branch.name} was deleted locally. No remote branch was changed.`
    });
    await onRefresh();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (renaming !== null) setRenaming(null);
      else if (remoteTag !== null) setRemoteTag(null);
      else if (createTagOpen) setCreateTagOpen(false);
      else if (remoteEditor !== null) setRemoteEditor(null);
      else if (pushOpen) setPushOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createTagOpen, onClose, pushOpen, remoteEditor, remoteTag, renaming]);

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="refs-browser"
        role="dialog"
        aria-label={`${repo.name} branches, tags, and remotes`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="refs-browser__head">
          <div>
            <div className="refs-browser__eyebrow">Repository refs</div>
            <div className="refs-browser__title">{repo.name}</div>
          </div>
          <span
            className="refs-browser__path"
            {...hoverTooltip(tip, repo.path)}
          >
            {repo.path}
          </span>
          <button className="refs-icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="refs-browser__toolbar">
          <div className="refs-tabs">
            <button
              className={tabClass("branches")}
              onClick={() => setTab("branches")}
            >
              Branches <span>{tabCounts.branches}</span>
            </button>
            <button
              className={tabClass("tags")}
              onClick={() => setTab("tags")}
            >
              Tags <span>{tabCounts.tags}</span>
            </button>
            <button
              className={tabClass("remotes")}
              onClick={() => setTab("remotes")}
            >
              Remotes <span>{tabCounts.remotes}</span>
            </button>
            {/* The forge's own noun, and no tab at all where origin has no
                forge: there is no list to show. */}
            {forge !== null && (
              <button
                className={tabClass("changeRequests")}
                onClick={() => setTab("changeRequests")}
              >
                {changeRequestPluralLabel(forge)}{" "}
                <span>{tabCounts.changeRequests}</span>
              </button>
            )}
          </div>
          <label className="refs-search">
            <span aria-hidden="true">⌕</span>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                shownTab === "changeRequests" && forge !== null
                  ? "Filter by number, title, branch, author…"
                  : `Filter ${shownTab}…`
              }
            />
          </label>
          {shownTab !== "tags" && (
            <button className="refs-action" onClick={() => setPushOpen(true)}>
              Push to remotes…
            </button>
          )}
          {shownTab === "tags" && (
            <button className="refs-action" onClick={() => setCreateTagOpen(true)}>
              Create tag…
            </button>
          )}
          {shownTab === "remotes" && (
            <button className="refs-action" onClick={() => setRemoteEditor("new")}>
              Add remote…
            </button>
          )}
        </div>

        <div className="refs-browser__body">
          {shownTab === "branches" && (
            <div className="refs-table">
              <div className="refs-table__header">
                <span>Branch</span>
                <span>Upstream</span>
                <span>Status</span>
                <span>Last commit</span>
                <span />
              </div>
              {branches.map((item) => {
                if (item.kind === "remote") {
                  const branch = item.branch;
                  return (
                    <div className="refs-table__row" key={branch.fullName}>
                      <BranchIdentity
                        name={branch.name}
                        hint={`${branch.qualifiedName}\nClick to copy branch name`}
                        subject={branch.subject}
                        pr={branch.pr}
                        matchedText={`${branch.qualifiedName} ${branch.subject ?? ""}`}
                        query={query}
                      />
                      <CopyTarget
                        value={branch.qualifiedName}
                        label={`Copy remote branch ${branch.qualifiedName}`}
                        hint={`${branch.qualifiedName}\nClick to copy remote branch`}
                        className="refs-table__muted refs-copyable-upstream copyable"
                      >
                        {branch.qualifiedName}
                      </CopyTarget>
                      <span className="refs-status refs-status--remote">Remote</span>
                      <span className="refs-table__muted">
                        {branch.lastCommitAt === undefined
                          ? "—"
                          : shortWhen(branch.lastCommitAt, now)}
                      </span>
                      <div className="refs-row-actions">
                        <SwitchHereButton
                          branch={branch.name}
                          worktree={focusedWorktree}
                          rowKey={branch.fullName}
                          inFlight={switching}
                          onSwitch={() =>
                            void switchHere(branch.fullName, branch.name)
                          }
                        />
                        <button
                          className="refs-row-action refs-row-action--quiet"
                          onClick={() => createRemoteWorktree(branch)}
                        >
                          New worktree
                        </button>
                      </div>
                    </div>
                  );
                }
                const branch = item.branch;
                return (
                  <div className="refs-table__row" key={branch.fullName}>
                    <BranchIdentity
                      name={branch.name}
                      hint={`${branch.name}\nClick to copy branch name`}
                      subject={branch.subject}
                      pr={branch.pr}
                      matchedText={localBranchText(branch)}
                      query={query}
                    />
                    {branch.upstream === undefined ? (
                      <span className="refs-table__muted">—</span>
                    ) : (
                      <CopyTarget
                        value={branch.upstream}
                        label={`Copy upstream branch ${branch.upstream}`}
                        hint={`${branch.upstream}\nClick to copy upstream branch`}
                        className="refs-table__muted refs-copyable-upstream copyable"
                      >
                        {branch.upstream}
                      </CopyTarget>
                    )}
                    <span className={`refs-status refs-status--${branch.tracking}`}>
                      {trackingLabel(branch)}
                    </span>
                    <span className="refs-table__muted">
                      {branch.lastCommitAt === undefined
                        ? "—"
                        : shortWhen(branch.lastCommitAt, now)}
                    </span>
                    <div className="refs-row-actions">
                      {branch.checkedOutWorktreeIds.length > 0 ? (
                        <button
                          className="refs-row-action"
                          onClick={() => {
                            const id = branch.checkedOutWorktreeIds[0];
                            if (id !== undefined) onRevealWorktree(id);
                            onClose();
                          }}
                        >
                          Show worktree
                        </button>
                      ) : (
                        <>
                          <SwitchHereButton
                            branch={branch.name}
                            worktree={focusedWorktree}
                            rowKey={branch.fullName}
                            inFlight={switching}
                            onSwitch={() =>
                              void switchHere(branch.fullName, branch.name)
                            }
                          />
                          <button
                            className="refs-row-action refs-row-action--quiet"
                            onClick={() => {
                              onCreateWorktree(branch.name, false);
                              onClose();
                            }}
                          >
                            New worktree
                          </button>
                        </>
                      )}
                      <button
                        className="refs-row-action refs-row-action--quiet"
                        aria-label={
                          branch.checkedOutWorktreeIds.length > 0
                            ? `Rename local branch ${branch.name} — unavailable, switch every worktree away from this branch first`
                            : `Rename local branch ${branch.name}`
                        }
                        {...hoverTooltip(
                          tip,
                          branch.checkedOutWorktreeIds.length > 0
                            ? "Switch every worktree away from this branch before renaming it"
                            : "Rename local branch"
                        )}
                        disabled={branch.checkedOutWorktreeIds.length > 0}
                        onClick={() => setRenaming(branch)}
                      >
                        Rename
                      </button>
                      <button
                        className="refs-row-action refs-row-action--quiet is-danger"
                        aria-label={
                          branch.checkedOutWorktreeIds.length > 0
                            ? `Delete local branch ${branch.name} — unavailable, switch every worktree away from this branch first`
                            : `Delete local branch ${branch.name}`
                        }
                        {...hoverTooltip(
                          tip,
                          branch.checkedOutWorktreeIds.length > 0
                            ? "Switch every worktree away from this branch before deleting it"
                            : "Delete local branch"
                        )}
                        disabled={
                          branch.checkedOutWorktreeIds.length > 0 ||
                          deleting !== null
                        }
                        onClick={() => void deleteBranch(branch)}
                      >
                        {deleting === branch.name ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                );
              })}
              {branches.length === 0 && !remoteSearch.loading && (
                <div className="refs-browser__empty">
                  No matching branches.
                  {/* A fork's PR, or one never fetched, has no branch here to
                      match — but the other tab can reach it. */}
                  {forge !== null && tabCounts.changeRequests > 0 && (
                    <>
                      {" "}
                      <button
                        className="refs-empty-link"
                        onClick={() => setTab("changeRequests")}
                      >
                        Show it in {changeRequestPluralLabel(forge)} →
                      </button>
                    </>
                  )}
                </div>
              )}
              {/* Count fetched rows, not rendered ones: a remote branch that
                  shadows a local one is still represented on screen — by the
                  local row it was folded into. Counting rendered rows instead
                  would leave the footer permanently short of its total with no
                  "Load more" to close the gap. */}
              <RefsPageFooter
                shown={localMatches.length + remoteSearch.rows.length}
                total={localMatches.length + remoteSearch.total}
                search={remoteSearch}
                note={
                  branchesMatchedViaPr && forge !== null
                    ? viaPrNote(forge, query)
                    : undefined
                }
              />
            </div>
          )}

          {shownTab === "changeRequests" &&
            forge !== null &&
            changeRequests.list !== null && (
              <ChangeRequestTable
                repoId={repo.id}
                forge={forge}
                list={changeRequests.list}
                error={changeRequests.error}
                query={query}
                lookup={lookup}
                now={now}
                focusedWorktree={focusedWorktree}
                switching={switching}
                onSwitch={switchHere}
                onRevealWorktree={onRevealWorktree}
                onCreateWorktree={onCreateWorktree}
                onClose={onClose}
              />
            )}

          {shownTab === "tags" && (
            <div className="refs-table refs-tag-table">
              {/* Object and Target were separate columns, and for a
                  lightweight tag they are the same object with the same type —
                  the overwhelming majority of rows repeated one id twice and
                  spent a quarter of the table doing it. One "points at" column
                  carries the peeled commit, which is what the tag marks; the
                  intermediate tag object an annotated tag adds appears only on
                  the rows that actually have one. */}
              <div className="refs-table__header refs-tag-table__row">
                <span>Tag</span>
                <span>Points at</span>
                <span>Annotation</span>
                <span>Actions</span>
              </div>
              {tagSearch.rows.map((tag) => (
                <div
                  className="refs-table__row refs-tag-table__row"
                  key={tag.fullName}
                >
                  <div className="refs-table__identity">
                    <span className="refs-tag-icon" aria-hidden="true">
                      #
                    </span>
                    <div>
                      <CopyTarget
                        value={tag.name}
                        label={`Copy tag name ${tag.name}`}
                        hint={`${tag.fullName}\nClick to copy tag name`}
                        className="refs-copyable-name copyable"
                      >
                        <strong>{tag.name}</strong>
                      </CopyTarget>
                      {/* Lightweight is the default and saying so on 97% of
                          rows is noise; annotated is the fact worth carrying. */}
                      {tag.kind === "annotated" && <small>annotated</small>}
                    </div>
                  </div>
                  <div className="refs-tag-object">
                    <span className="refs-tag-object__type">
                      {tag.targetType}
                    </span>
                    <CopyTarget
                      value={tag.targetId}
                      label={`Copy tag target ${tag.targetId}`}
                      hint={`${tag.targetId}\nClick to copy tag target`}
                      className="refs-plan__copy copyable"
                    >
                      {tag.targetId.slice(0, 12)}
                    </CopyTarget>
                    {/* Only when the tag ref does not point straight at the
                        commit — i.e. an annotated tag, where the tag object is
                        a distinct thing worth being able to copy. */}
                    {tag.objectId !== tag.targetId && (
                      <CopyTarget
                        value={tag.objectId}
                        label={`Copy tag object ${tag.objectId}`}
                        hint={`${tag.objectId}\nClick to copy the ${tag.objectType} object`}
                        className="refs-tag-object__via copyable"
                      >
                        via {tag.objectType} {tag.objectId.slice(0, 8)}
                      </CopyTarget>
                    )}
                  </div>
                  <div className="refs-tag-annotation">
                    {tag.annotation === undefined ? (
                      <span className="refs-table__muted">—</span>
                    ) : (
                      <>
                        <strong>{tag.annotation.subject || "Annotated tag"}</strong>
                        <small>
                          {tag.annotation.taggerName ?? "Unknown tagger"}
                          {tag.annotation.taggedAt === undefined
                            ? ""
                            : ` · ${shortWhen(tag.annotation.taggedAt, now)}`}
                        </small>
                        {tag.annotation.body !== undefined && (
                          <small {...hoverTooltip(tip, tag.annotation.body)}>
                            {tag.annotation.body}
                          </small>
                        )}
                      </>
                    )}
                  </div>
                  <div className="refs-tag-actions">
                    {/* Only when there is somewhere to locate into. The
                        disabled spelling below is reserved for the one reason
                        a reader can act on — the tag does not name a commit. */}
                    {onLocateTag !== undefined && (
                      <button
                        className="refs-row-action refs-row-action--icon"
                        /* The reason rides on the name: `title` is hover-only,
                           and assistive tech reads the label instead of it. */
                        aria-label={
                          tag.targetType === "commit"
                            ? `Locate tag ${tag.name} in lineage`
                            : `Locate tag ${tag.name} in lineage — unavailable, this tag points at a ${tag.targetType}, not a commit`
                        }
                        disabled={tag.targetType !== "commit"}
                        {...hoverTooltip(
                          tip,
                          tag.targetType === "commit"
                            ? "Locate tag in lineage"
                            : `This tag points at a ${tag.targetType}, not a commit`
                        )}
                        onClick={() => {
                          onLocateTag(repo.id, tag);
                          onClose();
                        }}
                      >
                        <LocateGlyph />
                        Locate
                      </button>
                    )}
                    <button
                      className="refs-row-action"
                      disabled={refs.remotes.length === 0}
                      onClick={() => setRemoteTag(tag)}
                    >
                      Remote…
                    </button>
                    <button
                      className="refs-row-action is-danger"
                      aria-label={`Delete local tag ${tag.name}`}
                      /* Busy, not unavailable: Chromium blurs an element the
                         moment it becomes disabled, so a delete started from
                         the keyboard would throw focus to <body> until it
                         returned (SC 2.4.3). aria-disabled says the same thing
                         and keeps the button focusable — the same rule
                         RepoRefsSections states for .ref-fetch-all. The
                         in-flight guard lives in deleteLocalTag. */
                      aria-disabled={deletingTag !== null}
                      onClick={() => void deleteLocalTag(tag)}
                    >
                      {deletingTag === tag.name ? "Deleting…" : "Delete local"}
                    </button>
                  </div>
                </div>
              ))}
              {/* "No matching" is only true when something was filtered out.
                  A repo with no tags at all is the common case here, and it
                  wants the answer plus the way forward, not a filter report. */}
              {tagSearch.rows.length === 0 && !tagSearch.loading && (
                <div className="refs-browser__empty">
                  {q === ""
                    ? "No local tags yet. Create one here, or right-click a commit in the graph."
                    : "No local tags match this filter."}
                </div>
              )}
              <RefsPageFooter
                shown={tagSearch.rows.length}
                total={tagSearch.total}
                search={tagSearch}
                noun="tags"
              />
            </div>
          )}

          {shownTab === "remotes" && (
            <div className="refs-remotes">
              {refs.remotes.map((remote) => (
                <section className="refs-remote-card" key={remote.name}>
                  <div className="refs-remote-card__head">
                    <div>
                      <strong>{remote.name}</strong>
                      <span className="refs-remote-role">
                        {remote.name === "origin"
                          ? "Default"
                          : remote.name === "upstream"
                            ? "Upstream"
                            : "Remote"}
                      </span>
                    </div>
                    <div className="refs-remote-card__actions">
                      <span>{remote.branchCount} branches</span>
                      <button onClick={() => setRemoteEditor(remote)}>Edit</button>
                      <button
                        className="is-danger"
                        onClick={() => void removeRemote(remote)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  <div className="refs-remote-card__urls">
                    <span>Fetch</span>
                    <code>{remote.fetchUrl}</code>
                    <span>Push</span>
                    <code>{remote.pushUrl}</code>
                    <span>Default</span>
                    <code>{remote.defaultBranch ?? "Unknown"}</code>
                  </div>
                  <RemoteBranchList
                    repoId={repo.id}
                    remote={remote.name}
                    query={query}
                    now={now}
                    refs={refs}
                    focusedWorktree={focusedWorktree}
                    switching={switching}
                    onSwitch={(rowKey, branch) => void switchHere(rowKey, branch)}
                    onPick={createRemoteWorktree}
                  />
                </section>
              ))}
              {refs.remotes.length === 0 && (
                <div className="refs-browser__empty">No remotes configured.</div>
              )}
            </div>
          )}
        </div>

        {pushOpen && (
          <PushRefsDialog
            repo={repo}
            refs={refs}
            onCompleted={onRefresh}
            onClose={() => setPushOpen(false)}
          />
        )}
        {remoteEditor !== null && (
          <RemoteEditorDialog
            repo={repo}
            {...(remoteEditor === "new" ? {} : { remote: remoteEditor })}
            onSaved={onRefresh}
            onClose={() => setRemoteEditor(null)}
          />
        )}
        {renaming !== null && (
          <BranchRenameDialog
            repoId={repo.id}
            branch={renaming}
            existingBranches={refs.branches.map((branch) => branch.name)}
            onRenamed={onRefresh}
            onClose={() => setRenaming(null)}
          />
        )}
        {createTagOpen && (
          <CreateTagDialog
            repoId={repo.id}
            repoName={repo.name}
            onCreated={tagsChanged}
            onClose={() => setCreateTagOpen(false)}
          />
        )}
        {remoteTag !== null && (
          <TagRemoteDialog
            repo={repo}
            tag={remoteTag}
            remotes={refs.remotes}
            // Nothing to refresh: pushing or deleting a remote tag leaves
            // every local ref, and so every row of this table, untouched.
            onCompleted={() => undefined}
            onClose={() => setRemoteTag(null)}
          />
        )}
      </div>
      {tip.tooltipNode}
    </div>
  );
}
