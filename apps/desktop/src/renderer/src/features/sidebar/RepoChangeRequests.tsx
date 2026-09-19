import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  changeRequestLabel,
  changeRequestMatch,
  changeRequestNoun,
  changeRequestNumberQuery,
  changeRequestPluralLabel,
  type ChangeRequestEntry,
  type ChangeRequestList,
  type ChangeRequestLocation,
  type ForgeKind,
  type OpenChangeRequest,
  type Worktree
} from "@pwrgit/shared";
import { shortWhen } from "../graph/graph-view";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { showErrorToast } from "../../lib/toast";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { CopyTarget } from "../shell/CopyTarget";
import { PrChip } from "./PrChip";
import { lastSegment } from "./repo-view";

/**
 * A repository's open change requests, read from main's cache.
 *
 * Opening asks main to re-list in the background (it declines inside its own
 * TTL), and `pr:openChanged` says when a re-read is worth doing. The first
 * paint is whatever the cache holds, so the tab never waits on a forge.
 */
export function useChangeRequestList(repoId: string): {
  list: ChangeRequestList | null;
  error: string | null;
} {
  const [list, setList] = useState<ChangeRequestList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(
    async (refresh: boolean): Promise<void> => {
      const stamp = ++generation.current;
      const result = await dispatch("pr:openList", { repoId, refresh });
      if (stamp !== generation.current) return;
      if (!result.ok) {
        setError(result.error.message.split("\n")[0] ?? "Load failed");
        return;
      }
      setError(null);
      setList(result.value);
    },
    [repoId]
  );

  useEffect(() => {
    void load(true);
    const stop = subscribe("pr:openChanged", (event) => {
      if (event.repoId === repoId) void load(false);
    });
    return () => {
      generation.current += 1;
      stop();
    };
  }, [load, repoId]);

  return { list, error };
}

/** Matched entries, the one the query names by number first. */
export function filterChangeRequests(
  entries: readonly ChangeRequestEntry[],
  query: string
): ChangeRequestEntry[] {
  if (query.trim() === "") return [...entries];
  const matched = entries.flatMap((entry) => {
    const how = changeRequestMatch(entry.pr, query);
    return how === null ? [] : [{ entry, how }];
  });
  return [
    ...matched.filter((item) => item.how === "number"),
    ...matched.filter((item) => item.how === "text")
  ].map((item) => item.entry);
}

const LOOKUP_DEBOUNCE_MS = 300;

export type ChangeRequestLookup =
  | { state: "idle" }
  | { state: "loading"; number: number }
  | { state: "done"; number: number; entry: ChangeRequestEntry | null };

/**
 * A number the open list does not hold — usually a merged or closed one —
 * asked of the forge once the query settles. Main remembers the answer for a
 * few minutes, so retyping it costs nothing.
 */
export function useChangeRequestLookup({
  repoId,
  query,
  list,
  enabled
}: {
  repoId: string;
  query: string;
  list: ChangeRequestList | null;
  enabled: boolean;
}): ChangeRequestLookup {
  const [lookup, setLookup] = useState<ChangeRequestLookup>({ state: "idle" });
  const number = changeRequestNumberQuery(query);
  const listed =
    number !== null &&
    (list?.entries.some((entry) => entry.pr.number === number) ?? false);
  const wanted = enabled && list?.forge != null && number !== null && !listed;

  useEffect(() => {
    if (!wanted || number === null) {
      setLookup({ state: "idle" });
      return;
    }
    let live = true;
    setLookup({ state: "loading", number });
    const timer = setTimeout(() => {
      void dispatch("pr:lookup", { repoId, number }).then((result) => {
        if (!live) return;
        setLookup({
          state: "done",
          number,
          entry: result.ok ? result.value : null
        });
      });
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [number, repoId, wanted]);

  return lookup;
}

/** The second-line tag: where this change request's head lives here. */
function locationTag(location: ChangeRequestLocation): {
  text: string;
  className: string;
  hint: string;
} {
  switch (location.kind) {
    case "worktree":
      return {
        text: "⌂ worktree",
        className: "is-worktree",
        hint: "Checked out in a worktree"
      };
    case "local":
      return {
        text: "local",
        className: "is-local",
        hint: `A local branch holds it: ${location.branch}`
      };
    case "remote":
      return {
        text: "origin",
        className: "is-remote",
        hint: `Fetched as ${location.fullName.replace(/^refs\/remotes\//, "")}`
      };
    case "unfetched":
      return {
        text: "not fetched",
        className: "is-unfetched",
        hint: "On origin, not fetched yet. Switching fetches it first."
      };
    case "fork":
      return {
        text: "fork",
        className: "is-fork",
        hint: location.fetchable
          ? `From ${location.headRepoPath}. Switching fetches it as ${location.localBranch}.`
          : `From ${location.headRepoPath}. This forge publishes no ref to fetch it by.`
      };
    case "missing":
      return {
        text: "branch gone",
        className: "is-missing",
        hint: "Its branch no longer exists on origin"
      };
  }
}

/** Short checks wording for the column; the chip's card has the full story. */
function checksWord(pr: OpenChangeRequest): string {
  if (pr.state !== "open") return pr.state;
  const parts: string[] = [];
  if (pr.isDraft) parts.push("draft");
  if (pr.mergeState === "conflicting") parts.push("conflicts");
  else if (pr.checkState !== undefined && pr.checkState !== "unknown") {
    parts.push(pr.checkState);
  }
  return parts.length === 0 ? "—" : parts.join(" · ");
}

function checksClass(pr: OpenChangeRequest): string {
  if (pr.state !== "open") return `is-${pr.state}`;
  if (pr.mergeState === "conflicting") return "is-failing";
  return pr.checkState === undefined ? "" : `is-${pr.checkState}`;
}

const toIso = (ms: number | undefined): string | null =>
  ms === undefined ? null : new Date(ms).toISOString();

/**
 * Bring a change request's head within reach of `git switch`: a fetch for an
 * unfetched or fork head, nothing for one already here. Null when there is
 * nothing to switch to (and the reason has been reported).
 */
async function reachableLocation(
  repoId: string,
  entry: ChangeRequestEntry
): Promise<ChangeRequestLocation | null> {
  const { location } = entry;
  if (location.kind !== "unfetched" && location.kind !== "fork") return location;
  const result = await dispatch("pr:fetchHead", {
    repoId,
    number: entry.pr.number
  });
  if (result.ok) return result.value;
  showErrorToast({
    title: `Could not fetch #${entry.pr.number}`,
    message: result.error.message.split("\n")[0] ?? result.error.message,
    detail: result.error.message
  });
  return null;
}

/**
 * The Pull requests / Merge requests tab: every open change request, where
 * its head lives in this checkout, and the verbs to get onto it — the same
 * verbs a branch row has, because that is what someone opens this for.
 */
export function ChangeRequestTable({
  repoId,
  forge,
  list,
  error,
  query,
  lookup,
  now,
  focusedWorktree,
  switching,
  onSwitch,
  onRevealWorktree,
  onCreateWorktree,
  onClose
}: {
  repoId: string;
  forge: ForgeKind;
  list: ChangeRequestList;
  error: string | null;
  query: string;
  lookup: ChangeRequestLookup;
  now: number;
  focusedWorktree: Worktree | null;
  /** The row key of the switch currently running, or null. */
  switching: string | null;
  onSwitch: (rowKey: string, branch: string) => Promise<void>;
  onRevealWorktree: (worktreeId: string) => void;
  onCreateWorktree: (
    branch: string,
    newBranch: boolean,
    startPoint?: string
  ) => void;
  onClose: () => void;
}) {
  const tip = useViewportTooltip();
  const [fetching, setFetching] = useState<number | null>(null);
  const noun = changeRequestNoun(forge);
  const plural = changeRequestPluralLabel(forge).toLowerCase();
  const matches = useMemo(
    () => filterChangeRequests(list.entries, query),
    [list.entries, query]
  );
  const looked =
    lookup.state === "done" && lookup.entry !== null ? lookup.entry : null;
  const rows = looked === null ? matches : [looked, ...matches];
  const busy = fetching !== null || switching !== null;

  const act = async (
    entry: ChangeRequestEntry,
    verb: "switch" | "worktree"
  ): Promise<void> => {
    if (busy) return;
    const rowKey = `pr:${entry.pr.number}`;
    setFetching(entry.pr.number);
    const location = await reachableLocation(repoId, entry);
    setFetching(null);
    if (location === null) return;
    if (location.kind === "worktree") {
      onRevealWorktree(location.worktreeId);
      onClose();
      return;
    }
    if (location.kind === "missing") return;
    const branch = location.branch;
    if (verb === "switch") {
      await onSwitch(rowKey, branch);
      return;
    }
    if (location.kind === "remote") {
      onCreateWorktree(branch, true, location.fullName);
    } else {
      onCreateWorktree(branch, false);
    }
    onClose();
  };

  const footer = (): string => {
    if (error !== null) return error;
    if (list.fetchedAt === null) return `Listing open ${plural}…`;
    const refreshed = shortWhen(new Date(list.fetchedAt).toISOString(), now);
    const head = `${list.entries.length} open · refreshed ${refreshed === "just now" ? "just now" : `${refreshed} ago`}`;
    return list.truncated
      ? `${head} · only the most recently updated are listed`
      : head;
  };

  return (
    <div className="refs-table refs-pr-table">
      <div className="refs-table__header refs-pr-table__row">
        <span>{changeRequestLabel(forge)}</span>
        <span>Author</span>
        <span>Checks</span>
        <span>Updated</span>
        <span />
      </div>
      {rows.map((entry) => {
        const { pr, location } = entry;
        const tag = locationTag(location);
        const rowKey = `pr:${pr.number}`;
        const isLookup = entry === looked;
        const updated = toIso(pr.updatedAt ?? pr.mergedAt ?? pr.closedAt ?? pr.createdAt);
        const unreachable =
          location.kind === "missing" ||
          (location.kind === "fork" && !location.fetchable);
        const reason =
          location.kind === "missing"
            ? `its branch no longer exists`
            : "this forge publishes no ref to fetch a fork's head by";
        const pending = fetching === pr.number;
        const switchingThis = switching === rowKey;
        const quiet = pr.state !== "open";
        const head = pr.headRefName ?? (location.kind === "fork" ? location.localBranch : "—");
        return (
          <div
            className={`refs-table__row refs-pr-table__row${isLookup ? " is-lookup" : ""}`}
            key={`${isLookup ? "lookup" : "open"}:${pr.number}`}
          >
            <div className="refs-table__identity refs-pr-identity">
              <PrChip pr={pr} />
              <div>
                <strong className="refs-pr-title" {...hoverTooltip(tip, pr.title)}>
                  {pr.title}
                </strong>
                <small className="refs-pr-where">
                  <span
                    className={`refs-pr-loc ${tag.className}`}
                    {...hoverTooltip(tip, tag.hint)}
                  >
                    {tag.text}
                  </span>
                  {/* A fork's head is copied as the local name it lands on:
                      that is the one `git switch` accepts here. */}
                  <CopyTarget
                    value={location.kind === "fork" ? location.localBranch : head}
                    label={`Copy branch name ${location.kind === "fork" ? location.localBranch : head}`}
                    hint={
                      location.kind === "fork"
                        ? `${location.headRepoPath}:${head}\nClick to copy ${location.localBranch}`
                        : `${head}\nClick to copy branch name`
                    }
                    className="refs-copyable-name copyable"
                  >
                    <span className="refs-copyable-name__text">
                      {location.kind === "fork"
                        ? `${location.headRepoPath}:${head}`
                        : head}
                    </span>
                  </CopyTarget>
                  {pr.baseRefName !== undefined && (
                    <span className="refs-pr-base"> → {pr.baseRefName}</span>
                  )}
                </small>
              </div>
            </div>
            <span className="refs-table__muted">{pr.author ?? "—"}</span>
            <span className={`refs-pr-checks ${checksClass(pr)}`}>
              {checksWord(pr)}
            </span>
            <span className="refs-table__muted">
              {updated === null ? "—" : shortWhen(updated, now)}
            </span>
            <div className="refs-row-actions">
              {location.kind === "worktree" ? (
                <button
                  className="refs-row-action"
                  onClick={() => {
                    onRevealWorktree(location.worktreeId);
                    onClose();
                  }}
                >
                  Show worktree
                </button>
              ) : (
                <>
                  <button
                    className={`refs-row-action${quiet ? " refs-row-action--quiet" : ""}`}
                    aria-label={
                      unreachable
                        ? `Switch to #${pr.number} — unavailable, ${reason}`
                        : focusedWorktree === null
                          ? `Switch to #${pr.number} — unavailable, nothing in this repository is the working target`
                          : `Switch ${lastSegment(focusedWorktree.path)} to #${pr.number}`
                    }
                    {...hoverTooltip(
                      tip,
                      unreachable
                        ? `Unavailable: ${reason}`
                        : focusedWorktree === null
                          ? "Select a worktree in this repository first"
                          : location.kind === "unfetched" || location.kind === "fork"
                            ? `Fetch #${pr.number}, then switch ${lastSegment(focusedWorktree.path)} to it`
                            : `Switch ${lastSegment(focusedWorktree.path)} to ${location.branch ?? head}`
                    )}
                    disabled={unreachable || focusedWorktree === null}
                    aria-disabled={busy && !pending && !switchingThis}
                    onClick={() => void act(entry, "switch")}
                  >
                    {pending ? "Fetching…" : switchingThis ? "Switching…" : "Switch here"}
                  </button>
                  <button
                    className="refs-row-action refs-row-action--quiet"
                    aria-label={
                      unreachable
                        ? `New worktree for #${pr.number} — unavailable, ${reason}`
                        : `New worktree for #${pr.number}`
                    }
                    disabled={unreachable}
                    aria-disabled={busy}
                    onClick={() => void act(entry, "worktree")}
                  >
                    New worktree
                  </button>
                </>
              )}
              <button
                className="refs-row-action refs-row-action--quiet refs-row-action--icon"
                aria-label={`Open ${noun} #${pr.number} in the browser`}
                {...hoverTooltip(tip, `Open ${noun} #${pr.number} in the browser`)}
                onClick={() => void dispatch("shell:openExternal", { url: pr.url })}
              >
                ↗
              </button>
            </div>
          </div>
        );
      })}
      {lookup.state === "loading" && (
        <div className="refs-pr-lookup">
          #{lookup.number} is not open. Looking it up…
        </div>
      )}
      {lookup.state === "done" && lookup.entry !== null && (
        <div className="refs-pr-lookup">
          #{lookup.number} is not open, so it was not in the cached list. Looked
          it up by number.
        </div>
      )}
      {lookup.state === "done" && lookup.entry === null && matches.length === 0 && (
        <div className="refs-browser__empty">
          No {noun} #{lookup.number} was found.
        </div>
      )}
      {rows.length === 0 && lookup.state === "idle" && (
        <div className="refs-browser__empty">
          {query.trim() === ""
            ? list.fetchedAt === null
              ? `Listing open ${plural}…`
              : `No open ${plural}.`
            : `No open ${plural} match ${query.trim()}.`}
        </div>
      )}
      <div className={`refs-page-footer${error !== null ? " is-error" : ""}`}>
        {footer()}
      </div>
      {tip.tooltipNode}
    </div>
  );
}
