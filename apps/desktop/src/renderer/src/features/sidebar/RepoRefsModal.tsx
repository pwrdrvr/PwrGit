import { BranchGlyph } from "../../lib/BranchGlyph";
import { LocateGlyph } from "../../lib/LocateGlyph";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  changeRequestMatch,
  changeRequestNoun,
  changeRequestNumberQuery,
  changeRequestSigil,
  routedRemotes,
  type ForgeKind,
  type LocalBranchSummary,
  type PrSummary,
  type RemoteBranchSummary,
  type RemoteSummary,
  type Repo,
  type RepoRefs,
  type RoutedRemote,
  type TagSummary,
  type Worktree
} from "@pwrgit/shared";
import { shortWhen } from "../graph/graph-view";
import { switchWorktreeToBranch } from "../shell/branchSwitch";
import { confirmDialog } from "../shell/dialogs";
import { dispatch } from "../../lib/pwrgit";
import { useFocusTrap } from "../../lib/useFocusTrap";
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
import { changeRequestWords } from "./change-request-groups";
import { lastSegment } from "./repo-view";
import { BranchRenameDialog } from "./BranchRenameDialog";
import { PushRefsDialog } from "./PushRefsDialog";
import { CreateTagDialog } from "./CreateTagDialog";
import { RemoteEditorDialog } from "./RemoteEditorDialog";
import { ForkParentRemoteDialog } from "./ForkParentRemoteDialog";
import { ForkRemoteStatus } from "./ForkRemoteStatus";
import { forkParentOffer } from "./fork-parent-offer";
import { useForgeHostMap } from "../../lib/useForgeHostMap";
import { TagRemoteDialog } from "./TagRemoteDialog";
import { PrChip } from "./PrChip";
import { RefRowActions, RefRowMenu } from "./RefRowMenu";
import { PinIcon } from "./WorktreeRow";
import {
  focusFirstRefsRow,
  handleRefsRowDoubleClick,
  handleRefsRowKey
} from "../../lib/refsRowKeys";
import { holderWorktreeId } from "./branch-focus";
import { ShowWorktreeButton, WorktreeHolderChip } from "./WorktreeHolderChip";
import { copyText } from "../../lib/copyText";
import {
  BRANCH_STATUS_FILTERS,
  branchMatchesStatus,
  branchStatusCounts,
  goneWithMergedPr,
  type BranchStatusFilter
} from "./branch-status";
import {
  ChangeRequestTable,
  filterChangeRequests,
  useChangeRequestList,
  useChangeRequestLookup,
  type CreateWorktreeFromRef
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

/**
 * The Upstream cell's text. When a branch tracks its own name on a remote —
 * nearly always — the cell repeated the name beside it and was clipped hard
 * at the 940px window, so it says only what differs: `origin/…`. The full
 * ref stays in the cell's card and is what a click copies (Post-ship 3b).
 */
export function upstreamShorthand(
  upstream: string,
  name: string,
  remotes: readonly string[]
): string {
  const suffix = `/${name}`;
  if (!upstream.endsWith(suffix)) return upstream;
  // What is left must be a remote, or the name only matched a tail:
  // `origin/feature/x` is not `x`'s own name, and `origin/feature/…` would
  // read as though it were.
  const remote = upstream.slice(0, -suffix.length);
  return remotes.includes(remote) ? `${remote}/…` : upstream;
}

/** What an empty filtered Branches tab says, per status. */
const EMPTY_STATUS: Record<Exclude<BranchStatusFilter, "all">, string> = {
  ahead: "No branches have commits to push.",
  behind: "No branches are behind the branch they track.",
  gone: "No branches have a deleted upstream.",
  unpublished: "No branches are local only."
};

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
  query,
  pin
}: {
  name: string;
  hint: string;
  subject: string | undefined;
  pr: PrSummary | undefined;
  /** The text the row's own filter matches, to tell a PR match apart. */
  matchedText: string;
  query: string;
  /** The star. Local branches only: a remote-tracking ref has no name of its
   *  own to pin, and its row keeps the empty slot so names stay aligned. */
  pin?: { pinned: boolean; onToggle: () => void };
}) {
  const tip = useViewportTooltip();
  const viaPr = matchedViaChangeRequest(matchedText, pr, query);
  const second = viaPr && pr !== undefined ? pr.title : subject;
  return (
    <div className="refs-table__identity">
      <span className="refs-pin-slot">
        {pin !== undefined && (
          <button
            type="button"
            data-refs-pin=""
            className={`pin refs-pin${pin.pinned ? " is-pinned" : ""}`}
            aria-label={`${pin.pinned ? "Unpin" : "Pin"} branch ${name}`}
            aria-pressed={pin.pinned}
            {...hoverTooltip(tip, pin.pinned ? "Unpin branch" : "Pin branch")}
            onClick={pin.onToggle}
          >
            <PinIcon filled={pin.pinned} size={11} />
          </button>
        )}
      </span>
      <span className="refs-branch-icon">
        <BranchGlyph />
      </span>
      <div>
        <span className="refs-branch-name-line">
          <CopyTarget
            value={name}
            label={`Copy branch name ${name}`}
            hint={hint}
            className="refs-copyable-name copyable"
            // The row runs its primary action on double-click; without the
            // deferral that would also replace the clipboard.
            deferForDoubleClick
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
      {tip.tooltipNode}
    </div>
  );
}

/** Why Rename and Delete are greyed on a branch a worktree holds. */
const RENAME_DELETE_HOLD =
  "Switch every worktree away from this branch first";

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

/**
 * The Gone view's lead: what the state means, and the way out of it.
 *
 * The count is a lead, not a verdict — a merged PR proves a branch finished
 * only when its tip is the PR's head, which the clean-up review checks row by
 * row before it offers anything.
 */
function GoneBanner({
  merged,
  noun,
  onCleanUp
}: {
  merged: number;
  noun: string;
  onCleanUp: (() => void) | undefined;
}) {
  return (
    <div className="refs-gone-banner">
      <div>
        <strong>
          {merged > 0
            ? `${merged} of these ${merged === 1 ? "has a" : "have a"} merged ${noun}.`
            : "Their remote branches were deleted."}
        </strong>
        <small>
          {merged > 0
            ? "Their remote branches were deleted after merging. "
            : ""}
          Clean-up checks each branch and shows its evidence before anything
          is deleted. Nothing on a remote is touched.
        </small>
      </div>
      {onCleanUp !== undefined && (
        <button className="refs-action" onClick={onCleanUp}>
          Clean up finished branches…
        </button>
      )}
    </div>
  );
}

/**
 * A remote branch's `⋮`, the same on the Branches tab and on its remote's
 * card, so the one branch never offers two different sets of verbs.
 */
function RemoteBranchMenu({ branch }: { branch: RemoteBranchSummary }) {
  return (
    <RefRowMenu
      label={`Actions for ${branch.qualifiedName}`}
      items={[
        // The short name, as a click on the name copies; the full ref is its
        // own entry (Post-ship 3c).
        {
          type: "item",
          label: "Copy branch name",
          onSelect: () => void copyText(branch.name)
        },
        {
          type: "item",
          label: `Copy ${branch.qualifiedName}`,
          onSelect: () => void copyText(branch.qualifiedName)
        }
      ]}
    />
  );
}

/** One remote's branches, paged rather than listed whole. */
function RemoteBranchList({
  repoId,
  repoName,
  remote,
  query,
  now,
  refs,
  focusedWorktree,
  switching,
  holderOf,
  onSwitch,
  onPick,
  onReveal
}: {
  repoId: string;
  repoName: string;
  remote: string;
  query: string;
  now: number;
  refs: RepoRefs;
  focusedWorktree: Worktree | null;
  /** The `fullName` of the row whose switch is running, or null. */
  switching: string | null;
  /** The worktree holding a local branch, as the sidebar picks it. */
  holderOf: (branch: LocalBranchSummary) => Worktree | undefined;
  onSwitch: (rowKey: string, branch: string) => void;
  onPick: (branch: RemoteBranchSummary) => void;
  onReveal: (worktreeId: string) => void;
}) {
  const search = useRemoteBranchSearch({ repoId, remote, query });
  const tip = useViewportTooltip();
  return (
    <div className="refs-remote-branches">
      {search.rows.map((branch) => {
        const local = localBranchForRemote(refs, branch);
        const checkedOut = (local?.checkedOutWorktreeIds.length ?? 0) > 0;
        const holder = local === undefined ? undefined : holderOf(local);
        return (
          <div
            className="refs-remote-branch"
            key={branch.fullName}
            data-refs-row=""
            tabIndex={-1}
          >
            <span className="refs-branch-icon">
              <BranchGlyph />
            </span>
            <div>
              <span className="refs-branch-name-line">
                <CopyTarget
                  value={branch.name}
                  label={`Copy branch name ${branch.name}`}
                  hint={`${branch.qualifiedName}\nClick to copy branch name`}
                  className="refs-copyable-name copyable"
                  deferForDoubleClick
                >
                  <strong>{branch.name}</strong>
                </CopyTarget>
                {branch.pr !== undefined && <PrChip pr={branch.pr} />}
                {holder !== undefined && (
                  <WorktreeHolderChip
                    holder={holder}
                    here={holder.id === focusedWorktree?.id}
                    subject={branch.name}
                    repoName={repoName}
                    tip={tip}
                    onReveal={onReveal}
                  />
                )}
              </span>
              {branch.subject !== undefined && <small>{branch.subject}</small>}
            </div>
            <span className="refs-table__muted">
              {branch.lastCommitAt === undefined
                ? "—"
                : shortWhen(branch.lastCommitAt, now)}
            </span>
            {/* The Branches tab's three fixed slots, so each verb holds the same
                place on every row and the age column lines up down the card.
                A branch a worktree already holds is a navigation problem, not a
                checkout one — git refuses the second checkout anyway, so the
                row leads with the worktree instead of a switch that cannot
                succeed, and its secondary slot stays empty: the chip naming
                that worktree is already on the name line. The primary slot is
                what Enter and double-click press (lib/refsRowKeys.ts). */}
            <RefRowActions
              primary={
                checkedOut ? (
                  <ShowWorktreeButton
                    holder={holder}
                    tip={tip}
                    onClick={() => onPick(branch)}
                  />
                ) : (
                  <SwitchHereButton
                    branch={branch.name}
                    worktree={focusedWorktree}
                    rowKey={branch.fullName}
                    inFlight={switching}
                    onSwitch={() => onSwitch(branch.fullName, branch.name)}
                  />
                )
              }
              secondary={
                checkedOut ? undefined : (
                  <button
                    className="refs-row-action refs-row-action--quiet"
                    onClick={() => onPick(branch)}
                  >
                    New worktree
                  </button>
                )
              }
              menu={<RemoteBranchMenu branch={branch} />}
            />
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
      {tip.tooltipNode}
    </div>
  );
}

export function RepoRefsModal({
  repo,
  refs,
  focusedWorktree,
  now,
  initialTab,
  initialStatus = "all",
  onCleanUpBranches,
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
  /** Which local branches the Branches tab starts on — the sidebar header's
   *  counts open it already filtered. */
  initialStatus?: BranchStatusFilter;
  /** Where the Gone view's "Clean up finished branches…" goes. Absent, the
   *  banner still explains the state but offers nothing to press. */
  onCleanUpBranches?: (() => void) | undefined;
  onRefresh: () => void | Promise<void>;
  onLocateTag?: ((repoId: string, tag: TagSummary) => void) | undefined;
  onRevealWorktree: (worktreeId: string) => void;
  /** The PR rides along from the Pull requests tab, as it does from the
   *  sidebar's +, so `NewWorktreeModal` names it. */
  onCreateWorktree: CreateWorktreeFromRef;
  onClose: () => void;
}) {
  const tip = useViewportTooltip();
  const [tab, setTab] = useState<RefsTab>(initialTab);
  const [status, setStatus] = useState<BranchStatusFilter>(initialStatus);
  const [query, setQuery] = useState("");
  const [pushOpen, setPushOpen] = useState(false);
  const [createTagOpen, setCreateTagOpen] = useState(false);
  const [remoteTag, setRemoteTag] = useState<TagSummary | null>(null);
  const [tagEpoch, setTagEpoch] = useState(0);
  const [remoteEditor, setRemoteEditor] = useState<RemoteSummary | "new" | null>(
    null
  );
  const [parentDialogOpen, setParentDialogOpen] = useState(false);
  const [addingParent, setAddingParent] = useState(false);
  const addingParentRef = useRef(false);
  const forgeHosts = useForgeHostMap();
  const parentOffer = forkParentOffer(repo.identity, refs.remotes, forgeHosts);
  // What each remote is, from the fork the forge confirmed — not its name.
  const { remoteRoles, forkKnown } = useMemo(() => {
    const rows = routedRemotes(repo.identity, refs.remotes, forgeHosts);
    return {
      remoteRoles: new Map(rows.map((row) => [row.name, row])),
      forkKnown: rows.some((row) => row.role === "fork")
    };
  }, [repo.identity, refs.remotes, forgeHosts]);
  const remoteNames = useMemo(
    () => refs.remotes.map((remote) => remote.name),
    [refs.remotes]
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
        branchMatchesStatus(branch, status) &&
        (q === "" ||
          localBranchText(branch).toLowerCase().includes(q) ||
          (branch.pr !== undefined && changeRequestMatch(branch.pr, q) !== null))
    );
    return matched.map((branch) => ({ kind: "local" as const, branch }));
  }, [q, refs.branches, status]);
  const statusCounts = useMemo(
    () => branchStatusCounts(refs.branches),
    [refs.branches]
  );
  // Every status but All is a tracking state, and a remote-tracking branch has
  // none — so a filtered view is local branches only, and says so by count.
  const statusFiltered = status !== "all";
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
    // The Remotes tab is not here: it renders its own per-remote list, and its
    // count is the remote count until a query makes `counting` true.
    enabled: tab === "branches" || counting
  });
  const tagSearch = useTagSearch({
    repoId: repo.id,
    query,
    enabled: tab === "tags" || counting,
    refreshKey: tagEpoch
  });
  const changeRequests = useChangeRequestList(repo.id);
  const forge = changeRequests.list?.forge ?? null;
  const words =
    forge === null ? null : changeRequestWords(changeRequests.list, forge);
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
      statusFiltered
        ? []
        : remoteSearch.rows
            .filter((branch) => !localNames.has(branch.name))
            .map((branch) => ({ kind: "remote" as const, branch })),
    [localNames, remoteSearch.rows, statusFiltered]
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
        // The footer's total, not the rows fetched so far — the two sit one
        // above the other, and a tab reading 47 over "Showing 47 of 140" is
        // the same search disagreeing with itself.
        branches:
          localMatches.length + (statusFiltered ? 0 : remoteSearch.total),
        tags: tagSearch.total,
        remotes: remoteSearch.total,
        changeRequests: changeRequestMatches.length + lookupHit
      }
    : {
        branches: statusFiltered ? localMatches.length : branchTabCount,
        tags: refs.tagCount,
        remotes: refs.remotes.length,
        changeRequests: changeRequests.list?.entries.length ?? 0
      };
  // Under a query the counts are hit counts: a tab with hits takes the
  // accent and an empty one dims, so nobody has to guess where to look.
  // Nothing is claimed while a count is still loading.
  const tabCountLoading: Record<RefsTab, boolean> = {
    branches: !statusFiltered && remoteSearch.loading,
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

  /** The worktree holding a branch, picked as the sidebar picks it: another
   *  checkout before the working target, since that is the one to go to. */
  const holderIdOf = (branch: LocalBranchSummary): string | null =>
    holderWorktreeId(branch, focusedWorktree?.id ?? null);
  const worktreesById = useMemo(
    () => new Map(repo.worktrees.map((worktree) => [worktree.id, worktree])),
    [repo.worktrees]
  );
  const holderOf = (branch: LocalBranchSummary): Worktree | undefined => {
    const id = holderIdOf(branch);
    return id === null ? undefined : worktreesById.get(id);
  };
  /** Going to a worktree is a navigation, so the browser closes. */
  const reveal = (worktreeId: string): void => {
    onRevealWorktree(worktreeId);
    onClose();
  };

  const createRemoteWorktree = (branch: RemoteBranchSummary): void => {
    const local = localBranchForRemote(refs, branch);
    const checkedOutId = local === undefined ? null : holderIdOf(local);
    if (checkedOutId !== null) onRevealWorktree(checkedOutId);
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
        detail: result.error.message,
        subject: { repoId: repo.id }
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
        detail: result.error.message,
        // Still there — the removal is what failed — so it can be gone to.
        subject: {
          repoId: repo.id,
          remote: { name: remote.name, url: remote.fetchUrl }
        }
      });
      return;
    }
    onRefresh();
  };

  const addForkParent = async (choice: {
    name: string;
    renameExistingTo?: string;
  }): Promise<boolean> => {
    if (addingParentRef.current) return false;
    addingParentRef.current = true;
    setAddingParent(true);
    try {
      const added = await dispatch("remote:addForkParent", {
        repoId: repo.id,
        ...choice
      });
      if (!added.ok) {
        showErrorToast({
          title: "Add fork parent failed",
          message: added.error.message,
          subject: { repoId: repo.id }
        });
        await onRefresh();
        return false;
      }
      const fetched = await dispatch("remote:fetchRepo", {
        repoId: repo.id,
        remote: added.value.name
      });
      await onRefresh();
      if (!fetched.ok) {
        showErrorToast({
          title: "Fork parent added; fetch failed",
          message: fetched.error.message,
          subject: {
            repoId: repo.id,
            remote: {
              name: added.value.name,
              url: repo.identity?.parent?.url ?? ""
            }
          }
        });
      }
      return true;
    } finally {
      addingParentRef.current = false;
      setAddingParent(false);
    }
  };

  const reportDeleteFailure = async (message: string): Promise<void> => {
    showErrorToast({
      title: "Delete branch failed",
      message: message.split("\n")[0] ?? message,
      detail: message,
      subject: { repoId: repo.id }
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
        "Git will delete this local branch only if its commits are merged into its upstream (or the current history when it has no upstream). No remote branch is changed." +
        // The ref listing prunes pins on branches Git no longer has, so the
        // sidebar row goes too; say so before it happens (Post-ship 3c).
        (isPinned(branch) ? "\n\nIt's also removed from Pinned in the sidebar." : ""),
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
        message: `${branch.name} was deleted locally. No remote branch was changed.`,
        subject: { repoId: repo.id }
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
      message: `${branch.name} was deleted locally. No remote branch was changed.`,
      subject: { repoId: repo.id }
    });
    await onRefresh();
  };

  // A pin shows at once and settles when the refreshed snapshot arrives; the
  // override is dropped then, so a pin changed elsewhere is not shadowed.
  const [pinOverride, setPinOverride] = useState<Record<string, boolean>>({});
  const isPinned = (branch: LocalBranchSummary): boolean =>
    pinOverride[branch.name] ?? branch.pinned === true;
  const toggleBranchPin = async (branch: LocalBranchSummary): Promise<void> => {
    const next = !isPinned(branch);
    setPinOverride((current) => ({ ...current, [branch.name]: next }));
    const result = await dispatch("branch:setPin", {
      repoId: repo.id,
      branch: branch.name,
      pinned: next
    });
    if (!result.ok) {
      showErrorToast({
        title: next ? "Pin failed" : "Unpin failed",
        message: result.error.message,
        subject: { repoId: repo.id }
      });
    } else {
      await onRefresh();
    }
    setPinOverride((current) => {
      const { [branch.name]: _settled, ...rest } = current;
      return rest;
    });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (renaming !== null) setRenaming(null);
      else if (remoteTag !== null) setRemoteTag(null);
      else if (createTagOpen) setCreateTagOpen(false);
      else if (remoteEditor !== null) setRemoteEditor(null);
      else if (parentDialogOpen) setParentDialogOpen(false);
      else if (pushOpen) setPushOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createTagOpen, onClose, parentDialogOpen, pushOpen, remoteEditor, remoteTag, renaming]);

  // Escape stays with the handler above, which closes a nested dialog's state
  // before the browser itself. The trap is what makes this a modal: without
  // it, Tab walked off the last row into the sidebar behind the backdrop. The
  // nested dialogs render inside, and their own traps win while they hold
  // focus.
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ open: true, containerRef: dialogRef, initialFocusRef: searchRef });

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="refs-browser"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
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
                {words?.plural}{" "}
                <span>{tabCounts.changeRequests}</span>
              </button>
            )}
          </div>
          <label className="refs-search">
            <span aria-hidden="true">⌕</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown") return;
                if (focusFirstRefsRow(bodyRef.current)) event.preventDefault();
              }}
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

        {shownTab === "branches" && (
          <div
            className="refs-status-bar"
            role="group"
            aria-label="Filter local branches by status"
          >
            <span className="refs-status-bar__label" aria-hidden="true">
              Status
            </span>
            {BRANCH_STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                className={`refs-status-chip${status === filter.value ? " is-active" : ""}`}
                aria-pressed={status === filter.value}
                onClick={() => setStatus(filter.value)}
              >
                {filter.label} <span>{statusCounts[filter.value]}</span>
              </button>
            ))}
          </div>
        )}
        {shownTab === "branches" && status === "gone" && statusCounts.gone > 0 && (
          <GoneBanner
            merged={goneWithMergedPr(refs.branches)}
            noun={words?.noun ?? "pull request"}
            onCleanUp={onCleanUpBranches}
          />
        )}

        <div
          className="refs-browser__body"
          ref={bodyRef}
          onKeyDown={(event) => {
            if (bodyRef.current === null) return;
            handleRefsRowKey(event, bodyRef.current, () =>
              searchRef.current?.focus()
            );
          }}
          onDoubleClick={(event) => {
            if (bodyRef.current === null) return;
            handleRefsRowDoubleClick(event, bodyRef.current);
          }}
        >
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
                    <div
                      className="refs-table__row"
                      key={branch.fullName}
                      data-refs-row=""
                      tabIndex={-1}
                    >
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
                        deferForDoubleClick
                      >
                        <span className="refs-copyable-upstream__text">
                          {upstreamShorthand(branch.qualifiedName, branch.name, remoteNames)}
                        </span>
                      </CopyTarget>
                      <span className="refs-status refs-status--remote">Remote</span>
                      <span className="refs-table__muted">
                        {branch.lastCommitAt === undefined
                          ? "—"
                          : shortWhen(branch.lastCommitAt, now)}
                      </span>
                      <RefRowActions
                        primary={
                          <SwitchHereButton
                            branch={branch.name}
                            worktree={focusedWorktree}
                            rowKey={branch.fullName}
                            inFlight={switching}
                            onSwitch={() =>
                              void switchHere(branch.fullName, branch.name)
                            }
                          />
                        }
                        secondary={
                          <button
                            className="refs-row-action refs-row-action--quiet"
                            onClick={() => createRemoteWorktree(branch)}
                          >
                            New worktree
                          </button>
                        }
                        menu={<RemoteBranchMenu branch={branch} />}
                      />
                    </div>
                  );
                }
                const branch = item.branch;
                const holderId = holderIdOf(branch);
                const checkedOut = holderId !== null;
                const holder =
                  holderId === null ? undefined : worktreesById.get(holderId);
                return (
                  <div
                    className={`refs-table__row${isPinned(branch) ? " is-pinned" : ""}`}
                    key={branch.fullName}
                    data-refs-row=""
                    tabIndex={-1}
                  >
                    <BranchIdentity
                      name={branch.name}
                      hint={`${branch.name}\nClick to copy branch name`}
                      subject={branch.subject}
                      pr={branch.pr}
                      matchedText={localBranchText(branch)}
                      query={query}
                      pin={{
                        pinned: isPinned(branch),
                        onToggle: () => void toggleBranchPin(branch)
                      }}
                    />
                    {branch.upstream === undefined ? (
                      <span className="refs-table__muted">—</span>
                    ) : (
                      <CopyTarget
                        value={branch.upstream}
                        label={`Copy upstream branch ${branch.upstream}`}
                        hint={`${branch.upstream}\nClick to copy upstream branch`}
                        className="refs-table__muted refs-copyable-upstream copyable"
                        deferForDoubleClick
                      >
                        {/* Its own box: the cell is inline-flex, and a bare
                            text node there could not draw an ellipsis. */}
                        <span className="refs-copyable-upstream__text">
                          {upstreamShorthand(branch.upstream, branch.name, remoteNames)}
                        </span>
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
                    <RefRowActions
                      primary={
                        holderId !== null ? (
                          <ShowWorktreeButton
                            holder={holder}
                            tip={tip}
                            onClick={() => reveal(holderId)}
                          />
                        ) : (
                          <SwitchHereButton
                            branch={branch.name}
                            worktree={focusedWorktree}
                            rowKey={branch.fullName}
                            inFlight={switching}
                            onSwitch={() =>
                              void switchHere(branch.fullName, branch.name)
                            }
                          />
                        )
                      }
                      // Where the sidebar row draws its chip — in place of +,
                      // which a held branch cannot offer — and it says which
                      // worktree "Show worktree" goes to.
                      secondary={
                        checkedOut ? (
                          holder !== undefined && (
                            <WorktreeHolderChip
                              holder={holder}
                              here={holder.id === focusedWorktree?.id}
                              subject={branch.name}
                              repoName={repo.name}
                              alwaysNameFolder
                              tip={tip}
                              onReveal={reveal}
                            />
                          )
                        ) : (
                          <button
                            className="refs-row-action refs-row-action--quiet"
                            onClick={() => {
                              onCreateWorktree(branch.name, false);
                              onClose();
                            }}
                          >
                            New worktree
                          </button>
                        )
                      }
                      menu={
                        <RefRowMenu
                          label={`Actions for ${branch.name}`}
                          items={[
                            // A checked-out branch's pin lands on the worktree
                            // holding it (RepoIndexer), so the entry is named
                            // for what it pins (Post-ship 3c).
                            {
                              type: "item",
                              label: `${isPinned(branch) ? "Unpin" : "Pin"} ${
                                checkedOut ? "worktree" : "branch"
                              }`,
                              ...(checkedOut && !isPinned(branch)
                                ? {
                                    hint: "This branch is checked out, so its worktree is what gets pinned."
                                  }
                                : {}),
                              onSelect: () => void toggleBranchPin(branch)
                            },
                            {
                              type: "item",
                              label: "Copy branch name",
                              onSelect: () => void copyText(branch.name)
                            },
                            { type: "sep" },
                            {
                              type: "item",
                              label: "Rename…",
                              disabled: checkedOut,
                              ...(checkedOut
                                ? { hint: RENAME_DELETE_HOLD }
                                : {}),
                              onSelect: () => setRenaming(branch)
                            },
                            {
                              type: "item",
                              label:
                                deleting === branch.name ? "Deleting…" : "Delete…",
                              danger: true,
                              disabled: checkedOut || deleting !== null,
                              ...(checkedOut
                                ? { hint: RENAME_DELETE_HOLD }
                                : {}),
                              onSelect: () => void deleteBranch(branch)
                            }
                          ]}
                        />
                      }
                    />
                  </div>
                );
              })}
              {branches.length === 0 && statusFiltered && q === "" && (
                <div className="refs-browser__empty">
                  {EMPTY_STATUS[status as Exclude<BranchStatusFilter, "all">]}
                </div>
              )}
              {branches.length === 0 &&
                !(statusFiltered && q === "") &&
                (statusFiltered || !remoteSearch.loading) && (
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
                        Show it in {words?.plural} →
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
              {/* A status filter lists local branches only, all of them, so
                  there is no remote page to extend. */}
              {!statusFiltered && (
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
              )}
            </div>
          )}

          {shownTab === "changeRequests" &&
            forge !== null &&
            changeRequests.list !== null && (
              <ChangeRequestTable
                repoId={repo.id}
                repoName={repo.name}
                worktrees={repo.worktrees}
                forge={forge}
                list={changeRequests.list}
                matches={changeRequestMatches}
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
                  data-refs-row=""
                  tabIndex={-1}
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
                        deferForDoubleClick
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
                      deferForDoubleClick
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
                        deferForDoubleClick
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
                  <RefRowActions
                    /* Locate is only offered when there is somewhere to locate
                       into. Its disabled spelling is reserved for the one
                       reason a reader can act on — the tag does not name a
                       commit. */
                    primary={
                      onLocateTag !== undefined && (
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
                      )
                    }
                    secondary={
                      <button
                        className="refs-row-action refs-row-action--quiet"
                        disabled={refs.remotes.length === 0}
                        onClick={() => setRemoteTag(tag)}
                      >
                        Remote…
                      </button>
                    }
                    menu={
                      <RefRowMenu
                        label={`Actions for tag ${tag.name}`}
                        items={[
                          {
                            type: "item",
                            label: "Copy tag name",
                            onSelect: () => void copyText(tag.name)
                          },
                          { type: "sep" },
                          /* Busy, not unavailable: a disabled control would
                             blur focus mid-operation (SC 2.4.3), but a menu
                             item is gone from view once picked, so `disabled`
                             is right here. The in-flight guard still lives in
                             deleteLocalTag. */
                          {
                            type: "item",
                            label:
                              deletingTag === tag.name
                                ? "Deleting…"
                                : "Delete local tag…",
                            danger: true,
                            disabled: deletingTag !== null,
                            onSelect: () => void deleteLocalTag(tag)
                          }
                        ]}
                      />
                    }
                  />
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
              <ForkRemoteStatus repo={repo} refs={refs} focusedWorktree={focusedWorktree} onRefresh={onRefresh} />
              {parentOffer !== null && (
                <section className="refs-remote-card refs-fork-parent-offer">
                  <div>
                    <strong>Fork parent: {parentOffer.parent}</strong>
                    <p>
                      This fork has no remote for its parent. Add one to check
                      its commits now and on future fetches.
                    </p>
                  </div>
                  <button
                    aria-disabled={addingParent}
                    aria-busy={addingParent}
                    onClick={() => {
                      if (addingParent) return;
                      if (parentOffer.upstreamOccupied) setParentDialogOpen(true);
                      else void addForkParent({ name: "upstream" });
                    }}
                  >
                    {addingParent
                      ? "Adding…"
                      : parentOffer.upstreamOccupied
                        ? "Set up parent remote…"
                        : "Add upstream"}
                  </button>
                </section>
              )}
              {refs.remotes.map((remote) => (
                <section className="refs-remote-card" key={remote.name}>
                  <div className="refs-remote-card__head">
                    <div>
                      <strong>{remote.name}</strong>
                      <RemoteRoleTag role={remoteRoles.get(remote.name)} name={remote.name}
                        forkKnown={forkKnown} />
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
                    repoName={repo.name}
                    remote={remote.name}
                    query={query}
                    now={now}
                    refs={refs}
                    focusedWorktree={focusedWorktree}
                    switching={switching}
                    holderOf={holderOf}
                    onSwitch={(rowKey, branch) => void switchHere(rowKey, branch)}
                    onPick={createRemoteWorktree}
                    onReveal={reveal}
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
        {parentDialogOpen && parentOffer !== null && (
          <ForkParentRemoteDialog
            parent={parentOffer.parent}
            suggestedName={parentOffer.suggestedName}
            remotes={refs.remotes}
            onAdd={addForkParent}
            onClose={() => setParentDialogOpen(false)}
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

/**
 * A remote card's role. Once the forge has named the fork and its parent,
 * those two say so by repository — and a remote merely called `upstream`
 * stops claiming to be the original. Without that answer the names are all
 * there is, and the old reading stands.
 */
function RemoteRoleTag({ role, name, forkKnown }: {
  role: RoutedRemote | undefined;
  name: string;
  /** The forge confirmed `origin` is a fork, so roles come from it. */
  forkKnown: boolean;
}) {
  if (role?.role === "fork" || role?.role === "original") {
    return <>
      <span className="refs-remote-role">{role.role === "fork" ? "Your fork" : "The original"}</span>
      {role.nameWithOwner !== null && <span className="refs-remote-slug">{role.nameWithOwner}</span>}
    </>;
  }
  return <span className="refs-remote-role">
    {name === "origin" ? "Default" : name === "upstream" && !forkKnown ? "Upstream" : "Remote"}
  </span>;
}
