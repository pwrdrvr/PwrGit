import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from "react";
import {
  forgeLabel,
  type ChangeRequestEntry,
  type ChangeRequestList,
  type OpenChangeRequest,
  type Repo
} from "@pwrgit/shared";
import { CheckoutGlyph } from "../../lib/CheckoutGlyph";
import { PlusGlyph } from "../../lib/PlusGlyph";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { shortWhen } from "../graph/graph-view";
import { CopyTarget } from "../shell/CopyTarget";
import {
  changeRequestKey,
  changeRequestWords,
  forkOwner,
  groupChangeRequests,
  lensRemotes,
  shownBase,
  type ChangeRequestRow
} from "./change-request-groups";
import { ForgeMark } from "./ForgeMark";
import { PrChip } from "./PrChip";
import { RemoteChip } from "./RemoteChip";
import {
  reachableLocation,
  useChangeRequestList,
  worktreeArgsFor
} from "./RepoChangeRequests";
import { SectionChevron } from "./SectionChevron";
import { lastSegment, worktreeFolderLabel } from "./repo-view";

/**
 * A value that outlives the window, per repository — the same localStorage
 * shape as the Worktrees toggle in RepoRow.
 */
function usePersistedValue(
  key: string,
  fallback: string
): [string, (value: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Ignore private-mode and quota failures.
    }
  }, [key, value]);
  return [value, setValue];
}

/** A disclosure, stored as "1" / "0". */
function usePersistedOpen(key: string): [boolean, (open: boolean) => void] {
  const [value, setValue] = usePersistedValue(key, "0");
  return [value === "1", (open) => setValue(open ? "1" : "0")];
}

/** More segments than this and the lens becomes a menu, so the head never wraps. */
const LENS_SEGMENTS_MAX = 3;

/** The leading unit of `shortWhen`: "2h 13m" is two columns of a row with none. */
function compactAge(updatedAt: number | undefined, now: number): string | null {
  if (updatedAt === undefined) return null;
  const when = shortWhen(new Date(updatedAt).toISOString(), now);
  return when === "just now" ? "now" : (when.split(" ")[0] ?? when);
}

export type CreateWorktreeFromRef = (
  branch: string,
  newBranch: boolean,
  startPoint?: string,
  changeRequest?: OpenChangeRequest
) => void;

/**
 * The repository's open pull or merge requests, between Worktrees and
 * Branches: what this machine holds first, what is only on the forge behind a
 * disclosure that starts closed.
 *
 * Everything drawn here comes from main's open-list cache — one list call per
 * repository, refreshed by the repo sweep — and nothing asks a forge about one
 * change request at a time. The only network a row can cause is the git fetch
 * that + Worktree runs for a head this checkout has not fetched yet.
 *
 * Design: `design/Change Requests in Sidebar - UX Review.dc.html`, 2b.
 */
export function RepoChangeRequestSection({
  repo,
  now,
  onRevealWorktree,
  onCreateWorktree,
  onOpenBrowser
}: {
  repo: Repo;
  now: number;
  onRevealWorktree: (worktreeId: string) => void;
  onCreateWorktree: CreateWorktreeFromRef;
  /** The refs browser on its Pull requests tab: search, and numbers that are
   *  not open. */
  onOpenBrowser: () => void;
}): ReactElement | null {
  const { list, error, refresh } = useChangeRequestList(repo.id, {
    refreshOnOpen: false,
    // A worktree created from a row (or removed) moves that row between the
    // groups without any change to the open list itself.
    relocateKey: repo.worktrees.map((w) => `${w.id}:${w.branch}`).join("|")
  });
  const tip = useViewportTooltip();
  const [open, setOpen] = usePersistedOpen(
    `pwrgit.changeRequestsOpen.${repo.id}`
  );
  // Closed until the reader opens it: a busy repository's remote list is
  // mostly other people's work and bots, and the Local group is the point.
  const [remoteOpen, setRemoteOpen] = usePersistedOpen(
    `pwrgit.changeRequestsRemoteOpen.${repo.id}`
  );
  const [lens, setLens] = usePersistedValue(`pwrgit.changeRequestsLens.${repo.id}`, "all");
  const [failingOnly, setFailingOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fetching, setFetching] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);

  // No forge on origin: no section at all, rather than a heading that can only
  // ever say 0. Before this session's first answer, origin's identity predicts
  // the forge, so the heading arrives with Branches and Tags instead of
  // pushing them down a moment later.
  const predicted =
    repo.identity === undefined || repo.identity.host === "other"
      ? null
      : repo.identity.host;
  const loading = list == null;
  const forge = loading ? predicted : (list.forge ?? null);
  if (forge === null) return null;
  const shown: ChangeRequestList = list ?? {
    forge,
    fetchedAt: null,
    truncated: false,
    entries: [],
    remotes: []
  };
  // A checkout on GitHub with a GitLab mirror lists both kinds; the heading
  // names both only then.
  const mixed = new Set(shown.remotes.map((remote) => remote.forge)).size > 1;
  const { plural, noun } = changeRequestWords(shown, forge);
  // The lens appears only with two or more remotes that have something open,
  // and a remembered remote that no longer has any reads as All.
  const lensOptions = lensRemotes(shown, repo.identity?.parent?.nameWithOwner);
  const activeLens =
    lensOptions.length >= 2 &&
    lensOptions.some((option) => option.remote.forgeRepo === lens)
      ? lens
      : "all";
  const visible =
    activeLens === "all"
      ? shown.entries
      : shown.entries.filter((entry) => entry.forgeRepo === activeLens);
  // On All, each row says which remote it is from; a lens on one says it once.
  const remoteChips = lensOptions.length >= 2 && activeLens === "all";
  const manyRemotes = shown.remotes.length > 1;
  const groups = groupChangeRequests(visible, { failingOnly });
  const rows = remoteOpen
    ? [...groups.local, ...groups.remoteOnly]
    : groups.local;
  const defaultBranch = repo.worktrees.find((w) => w.isPrimary)?.defaultBranch;
  const worktreesById = new Map(repo.worktrees.map((w) => [w.id, w]));
  // Nothing cached yet: the repo sweep lists it shortly, or ⟳ does now. Not a
  // spinner — with the forge unreachable it would spin forever.
  const unlisted = !loading && shown.fetchedAt === null && shown.entries.length === 0;
  const failure = shown.failure;
  const since = (at: number): string => {
    const ago = shortWhen(new Date(at).toISOString(), now);
    return ago === "just now" ? "just now" : `${ago} ago`;
  };

  const refreshedHint = (): string => {
    if (failure !== undefined) {
      return `Couldn't refresh (${since(failure.at)}): ${failure.message} — try again`;
    }
    if (shown.fetchedAt === null) return `Ask the forge for open ${plural.toLowerCase()}`;
    return `Refreshed ${since(shown.fetchedAt)} — ask again`;
  };

  const act = async (entry: ChangeRequestEntry): Promise<void> => {
    if (fetching !== null) return;
    setFetching(changeRequestKey(entry));
    const location = await reachableLocation(repo.id, entry);
    setFetching(null);
    if (location === null) return;
    if (location.kind === "worktree") {
      onRevealWorktree(location.worktreeId);
      return;
    }
    const args = worktreeArgsFor(location);
    if (args === null) return;
    onCreateWorktree(args.branch, args.newBranch, args.startPoint, entry.pr);
  };

  /** What + Worktree will do, said before the click. Null: it cannot. */
  const worktreeHint = (entry: ChangeRequestEntry): string | null => {
    const { pr, location } = entry;
    switch (location.kind) {
      case "worktree":
        return null;
      case "local":
        return `New worktree on ${location.branch}`;
      case "remote":
        return `New worktree on ${location.branch}, from ${location.fullName.replace(/^refs\/remotes\//, "")}`;
      case "unfetched":
        return `New worktree from #${pr.number} — fetches ${location.remote}/${location.branch} first`;
      case "fork":
        return location.fetchable
          ? `New worktree from #${pr.number} — fetches it from ${location.headRepoPath} as ${location.localBranch}`
          : null;
      case "missing":
        return null;
    }
  };

  const onRowKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    index: number,
    entry: ChangeRequestEntry
  ): void => {
    if (event.target !== event.currentTarget) return;
    const move = (next: number): void => {
      event.preventDefault();
      event.stopPropagation();
      const clamped = Math.max(0, Math.min(next, rows.length - 1));
      setCursor(clamped);
      const group = event.currentTarget.closest('[role="group"]');
      const target = group?.querySelectorAll<HTMLElement>(".ref-cr-row")[clamped];
      target?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(rows.length - 1);
    else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (entry.location.kind === "worktree") {
        onRevealWorktree(entry.location.worktreeId);
      } else if (worktreeHint(entry) !== null) {
        void act(entry);
      }
    }
  };

  const row = ({ entry, paired }: ChangeRequestRow, index: number): ReactElement => {
    const { pr, location } = entry;
    const key = changeRequestKey(entry);
    const age = compactAge(pr.updatedAt ?? pr.createdAt, now);
    // Null only for a missing head the forge did not name either: nothing to
    // copy, so no copy target.
    const head =
      location.kind === "fork"
        ? (pr.headRefName ?? location.localBranch)
        : (pr.headRefName ?? location.branch);
    const base = shownBase(pr, defaultBranch);
    const holder =
      location.kind === "worktree" ? worktreesById.get(location.worktreeId) : undefined;
    const folder =
      holder === undefined
        ? null
        : worktreeFolderLabel(holder.branch, holder.path, [repo.name]);
    const hint = worktreeHint(entry);
    const pending = fetching === key;
    const cursorIndex = Math.min(cursor, rows.length - 1);
    return (
      <div
        className={`ref-cr-row${location.kind === "worktree" ? " is-checked-out" : ""}`}
        key={key}
        // Back returns the sidebar to this row (sidebar-anchor.ts).
        data-nav-anchor={`cr:${repo.id}:${key}`}
        role="treeitem"
        aria-level={3}
        aria-posinset={index + 1}
        aria-setsize={rows.length}
        aria-label={`#${pr.number} ${pr.title}${manyRemotes ? `, on ${entry.remote}` : ""}`}
        tabIndex={index === cursorIndex ? 0 : -1}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setCursor(index);
        }}
        onKeyDown={(event) => onRowKeyDown(event, index, entry)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (location.kind === "worktree") onRevealWorktree(location.worktreeId);
        }}
      >
        <div className="ref-cr-row__line">
          <PrChip pr={pr} />
          <span className="ref-cr-row__title" {...hoverTooltip(tip, pr.title)}>
            {pr.title}
          </span>
          {age !== null && <span className="ref-cr-row__age">{age}</span>}
          {location.kind === "worktree" ? (
            <button
              className="ref-mini-action"
              aria-label={`Show the worktree with #${pr.number} checked out`}
              {...hoverTooltip(tip, "Show checked-out worktree")}
              onClick={(event) => {
                event.stopPropagation();
                onRevealWorktree(location.worktreeId);
              }}
            >
              <CheckoutGlyph />
            </button>
          ) : (
            <button
              className="ref-mini-action"
              aria-label={
                hint === null
                  ? `New worktree for #${pr.number} — unavailable`
                  : `New worktree for #${pr.number}`
              }
              aria-busy={pending}
              {...hoverTooltip(
                tip,
                hint ??
                  (location.kind === "missing"
                    ? "Unavailable: its branch no longer exists"
                    : "Unavailable: this forge publishes no ref to fetch a fork's head by")
              )}
              disabled={hint === null}
              aria-disabled={fetching !== null}
              onClick={(event) => {
                event.stopPropagation();
                void act(entry);
              }}
            >
              <PlusGlyph />
            </button>
          )}
        </div>
        <div className="ref-cr-row__where">
          {remoteChips && (
            <RemoteChip remote={entry.remote} forge={pr.forge ?? forge} tip={tip} />
          )}
          {paired.map((other) => (
            <span
              className="ref-cr-paired"
              key={changeRequestKey(other)}
              aria-label={`Also #${other.pr.number} on ${other.remote}`}
            >
              <PrChip pr={other.pr} />
              {manyRemotes && (
                <span className="ref-cr-paired__remote">{other.remote}</span>
              )}
            </span>
          ))}
          {location.kind === "worktree" && (
            <button
              className="ref-checkout-chip is-here"
              aria-label={`Go to ${holder === undefined ? "the worktree" : lastSegment(holder.path)}`}
              {...hoverTooltip(tip, holder?.path ?? "Checked out in a worktree")}
              onClick={(event) => {
                event.stopPropagation();
                onRevealWorktree(location.worktreeId);
              }}
            >
              <span aria-hidden="true">⌂</span>
              {folder !== null && (
                <span className="ref-checkout-chip__name">{folder}</span>
              )}
            </button>
          )}
          {location.kind === "local" && (
            <span
              className="ref-cr-tag"
              {...hoverTooltip(tip, `A local branch holds it: ${location.branch}`)}
            >
              local
            </span>
          )}
          {location.kind === "fork" && (
            <span
              className="ref-cr-tag is-fork"
              {...hoverTooltip(tip, `From ${location.headRepoPath}`)}
            >
              {forkOwner(location.headRepoPath)}
            </span>
          )}
          {location.kind === "missing" && (
            <span className="ref-cr-tag is-missing">branch gone</span>
          )}
          {head === null ? (
            <span className="ref-cr-row__head">—</span>
          ) : (
            <CopyTarget
              value={location.kind === "fork" ? location.localBranch : head}
              label={`Copy branch name ${location.kind === "fork" ? location.localBranch : head}`}
              hint={
                location.kind === "fork"
                  ? `${location.headRepoPath}:${head}\nClick to copy ${location.localBranch}`
                  : `${head}\nClick to copy branch name`
              }
              className="ref-cr-row__head refs-copyable-name copyable"
            >
              <span className="refs-copyable-name__text">{head}</span>
            </CopyTarget>
          )}
          {base !== null && <span className="ref-cr-row__base">→ {base}</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="ref-section ref-cr-section">
      <div className="ref-section__head-wrap">
        <button
          className="ref-section__head"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(!open);
          }}
        >
          <SectionChevron open={open} />
          <span className="ref-section__label">{plural}</span>
          <span className="ref-section__count">
            {loading ? "…" : unlisted ? "–" : visible.length}
          </span>
        </button>
        {/* Kept while the filter is on even after a refresh leaves nothing
            failing: it is the only way to turn the filter back off. */}
        {(groups.failing > 0 || failingOnly) && (
          <span className="ref-section__chips">
            <button
              className={`ref-section__chip is-failing${failingOnly ? " is-active" : ""}`}
              aria-pressed={failingOnly}
              aria-label={
                failingOnly
                  ? `Show every open ${noun}`
                  : `Show only the ${groups.failing} failing`
              }
              {...hoverTooltip(
                tip,
                failingOnly
                  ? `Showing failing checks and conflicts — show every open ${noun}`
                  : "Failing checks or conflicts — show only these"
              )}
              onClick={(event) => {
                event.stopPropagation();
                setFailingOnly(!failingOnly);
                if (failingOnly) return;
                setOpen(true);
                // "Show only these" has to show them: a failing PR that is
                // only on the forge would otherwise sit in a closed group.
                if (groupChangeRequests(visible, { failingOnly: true }).remoteOnly.length > 0) {
                  setRemoteOpen(true);
                }
              }}
            >
              {groups.failing} failing
            </button>
          </span>
        )}
        <button
          className={`ref-fetch-all${failure === undefined ? "" : " is-warn"}`}
          aria-label={`Refresh open ${plural.toLowerCase()} for ${repo.name}${
            failure === undefined ? "" : ", last refresh failed"
          }`}
          aria-busy={refreshing}
          aria-disabled={refreshing}
          {...hoverTooltip(tip, refreshedHint())}
          onClick={(event) => {
            event.stopPropagation();
            if (refreshing) return;
            setRefreshing(true);
            void refresh().finally(() => setRefreshing(false));
          }}
        >
          <RefreshGlyph />
        </button>
      </div>
      {open && (
        <div className="ref-section__body">
          {error !== null && <div className="ref-section__error">{error}</div>}
          {failure !== undefined && (
            <div className="ref-cr-stale" role="status">
              Couldn't refresh: {failure.message}
              {shown.fetchedAt === null
                ? ""
                : ` Showing the list from ${since(shown.fetchedAt)}.`}
            </div>
          )}
          {lensOptions.length >= 2 &&
            (lensOptions.length <= LENS_SEGMENTS_MAX ? (
              <div
                className="ref-cr-lens"
                role="group"
                aria-label={`Show ${plural.toLowerCase()} from`}
              >
                {[
                  { value: "all", label: "All", count: shown.entries.length, forge: null },
                  ...lensOptions.map((option) => ({
                    value: option.remote.forgeRepo,
                    label: option.remote.name,
                    count: option.count,
                    forge: option.remote.forge
                  }))
                ].map((segment) => (
                  <button
                    key={segment.value}
                    className={`ref-cr-lens__seg${activeLens === segment.value ? " is-active" : ""}`}
                    aria-pressed={activeLens === segment.value}
                    {...hoverTooltip(
                      tip,
                      segment.value === "all"
                        ? "Every remote's open list"
                        : `Only what ${segment.label} lists`
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      setLens(segment.value);
                    }}
                  >
                    {/* The mark only where the forges differ: there a remote's
                        name alone ("gitlab") would be a coincidence. */}
                    {mixed && segment.forge !== null && (
                      <ForgeMark kind={segment.forge} size={10} />
                    )}
                    <span className="ref-cr-lens__label">{segment.label}</span>
                    <span className="ref-section__count">{segment.count}</span>
                  </button>
                ))}
              </div>
            ) : (
              <label
                className="ref-cr-lens ref-cr-lens--menu"
                onClick={(event) => event.stopPropagation()}
              >
                <span className="ref-cr-lens__label">Remote</span>
                <select
                  value={activeLens}
                  onChange={(event) => setLens(event.target.value)}
                >
                  <option value="all">All ({shown.entries.length})</option>
                  {lensOptions.map((option) => (
                    <option key={option.remote.forgeRepo} value={option.remote.forgeRepo}>
                      {option.remote.name} ({option.count})
                    </option>
                  ))}
                </select>
              </label>
            ))}
          {loading ? null : unlisted ? (
            <div className="ref-section__empty">
              Not listed yet — ⟳ asks {forgeLabel(forge)}.
            </div>
          ) : visible.length === 0 ? (
            <div className="ref-section__empty">No open {plural.toLowerCase()}.</div>
          ) : (
            <div
              role="group"
              aria-label={`${repo.name} ${plural.toLowerCase()}`}
              className="ref-cr-list"
            >
              <div className="ref-cr-subhead">
                <span className="ref-cr-subhead__label">Local</span>
                <span className="ref-section__count">{groups.local.length}</span>
              </div>
              {groups.local.map((item, index) => row(item, index))}
              {groups.local.length === 0 && (
                <div className="ref-section__empty">
                  {failingOnly
                    ? "None failing here."
                    : `No branch here holds an open ${noun}.`}
                </div>
              )}
              <button
                className="ref-cr-subhead ref-cr-subhead--toggle"
                aria-expanded={remoteOpen}
                onClick={(event) => {
                  event.stopPropagation();
                  setRemoteOpen(!remoteOpen);
                }}
              >
                <SectionChevron open={remoteOpen} />
                <span className="ref-cr-subhead__label">Remote only</span>
                <span className="ref-section__count">{groups.remoteOnly.length}</span>
              </button>
              {remoteOpen &&
                groups.remoteOnly.map((item, index) =>
                  row(item, groups.local.length + index)
                )}
            </div>
          )}
          {shown.truncated && (
            <div className="ref-section__empty">
              Only the most recently updated are listed.
            </div>
          )}
          <button
            className="ref-view-all"
            onClick={(event) => {
              event.stopPropagation();
              onOpenBrowser();
            }}
          >
            Search {plural.toLowerCase()}, including closed…
          </button>
        </div>
      )}
      {tip.tooltipNode}
    </div>
  );
}
