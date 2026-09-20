import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ASSUMED_FORGE_KIND,
  ok,
  changeRequestLabel,
  changeRequestNoun,
  changeRequestNumberQuery,
  type ChangeRequestLocation,
  type Commit,
  type FileSearchHit,
  type RepoSearchHit,
  type SearchHitStatus
} from "@pwrgit/shared";
import { createAsyncFill } from "../../lib/asyncFill";
import { copyText } from "../../lib/copyText";
import {
  currentPlatform,
  shortcutLabel
} from "../../lib/platform";
import { dispatch, windowProfileId } from "../../lib/pwrgit";
import { useRelativeClock } from "../../lib/useRelativeClock";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { shortWhen } from "../graph/graph-view";
import { commitHashQuery, searchCommits } from "./commit-search";
import { ContextMenu } from "../shell/ContextMenu";
import { PrChip } from "./PrChip";
import { worktreeFolderLabel } from "./repo-view";
import { PinIcon } from "./WorktreeRow";

// The kind's own identity within its repo: a worktree id, a fetched ref, or —
// for a local branch, which carries neither — the branch name itself. Two local
// branches in one repo would otherwise share a React key.
// A change request's name is its title, which two PRs can share; its number
// cannot be.
const hitKey = (hit: RepoSearchHit): string =>
  `${hit.kind}:${hit.repoId}:${
    hit.worktreeId ??
    hit.remoteRef ??
    (hit.kind === "change_request" ? `#${hit.pr?.number ?? hit.name}` : hit.name)
  }`;

function resolvePaletteHits(
  hits: RepoSearchHit[],
  resolved: ReadonlyMap<string, RepoSearchHit | null>
): RepoSearchHit[] {
  const seen = new Set<string>();
  return hits.map((hit) => resolved.get(hitKey(hit)) ?? hit).filter((hit) => {
    const key = hitKey(hit);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A branch hit with no worktree behind it: nothing to pin, no status to fill,
 *  and picking it opens the New worktree modal instead of selecting a row. */
const isWorktreelessBranch = (hit: RepoSearchHit): boolean =>
  hit.kind === "remote_branch" || hit.kind === "local_branch";

/** Nothing on disk to pin or read status from: a bare branch, or an open
 *  change request whose head is not in this checkout at all. */
const hasNoCheckout = (hit: RepoSearchHit): boolean =>
  isWorktreelessBranch(hit) || hit.kind === "change_request";

/** The forge's own word for a hit's change request ("Pull request"). */
const changeRequestWord = (hit: RepoSearchHit): string =>
  changeRequestLabel(hit.pr?.forge ?? ASSUMED_FORGE_KIND);

/** The directory a worktree hit lives in, when its branch name doesn't say.
 *  Paths are indexed too (0008_search_fts weights them below names), so a query
 *  typed from a shell prompt matches a worktree whose branch has since been
 *  renamed — and without this the row that came back named a branch the user
 *  had never heard of, with nothing to connect it to what they searched for. */
const hitFolderLabel = (hit: RepoSearchHit): string | null =>
  hit.kind === "worktree"
    ? worktreeFolderLabel(hit.name, hit.path, [hit.repoName])
    : null;

/** The word the row's leading glyph stands for.
 *  Both the glyph's tooltip and the first thing the row says to a screen
 *  reader: `.overlay-result` is a `role="option"`, so its accessible name is
 *  built from its subtree, and the kind is otherwise unsaid for two of the
 *  four kinds — `.overlay-result__meta` names the repo for a worktree and the
 *  worktree count for a repo, never the kind itself. */
const hitKindLabel = (hit: RepoSearchHit): string =>
  hit.kind === "worktree"
    ? "Worktree"
    : hit.kind === "local_branch"
    ? "Local branch"
    : hit.kind === "remote_branch"
    ? "Remote branch"
    : hit.kind === "change_request"
    ? changeRequestWord(hit)
    : "Repo";

export type PaletteItem =
  | { kind: "commit"; commit: Commit }
  | { kind: "file"; hit: FileSearchHit }
  | { kind: "repo"; hit: RepoSearchHit };

/** A row's menu entry: copy a value, or open a URL in the browser. */
type CopyAction = { label: string; value: string; open?: true };

function paletteCopyActions(item: PaletteItem | undefined): CopyAction[] {
  if (item === undefined) return [];
  if (item.kind === "commit") {
    return [{ label: "Copy commit hash", value: item.commit.hash }];
  }
  if (item.kind === "file") {
    return [{ label: "Copy file path", value: item.hit.path }];
  }
  const hit = item.hit;
  if (hit.kind === "repo") {
    return [
      { label: "Copy repo name", value: hit.name },
      { label: "Copy repo path", value: hit.path }
    ];
  }
  const actions: CopyAction[] = [];
  // A change request's name is its title; its branch is the head. A fork's
  // head is a branch in somebody else's repository, so there is no name here
  // worth copying until it has been fetched as `pr/N`.
  const branch =
    hit.kind === "change_request"
      ? hit.pr?.headRepoPath === undefined
        ? hit.pr?.headRefName
        : undefined
      : hit.kind !== "worktree" || !hit.name.startsWith("detached@")
        ? hit.name
        : undefined;
  if (branch !== undefined) {
    actions.push({ label: "Copy branch name", value: branch });
  }
  // Branch-only hits carry the repository path, not a checked-out worktree.
  if (hit.kind === "worktree") {
    actions.push({ label: "Copy worktree path", value: hit.path });
  }
  if (hit.pr?.url) {
    // The forge's own noun, in both: "Copy PR URL" over "Open merge request
    // #12" is one menu contradicting itself.
    const noun = changeRequestNoun(hit.pr.forge ?? ASSUMED_FORGE_KIND);
    actions.push({ label: `Copy ${noun} URL`, value: hit.pr.url });
    actions.push({
      label: `Open ${noun} #${hit.pr.number}`,
      value: hit.pr.url,
      open: true
    });
  }
  return actions;
}

export const paletteItemKey = (item: PaletteItem): string =>
  item.kind === "commit"
    ? `commit:${item.commit.hash}`
    : item.kind === "file"
      ? `file:${item.hit.path}`
      : hitKey(item.hit);

export function selectedPaletteItemIndex(
  items: PaletteItem[],
  selectedKey: string | null
): number {
  if (selectedKey === null) return 0;
  const index = items.findIndex((item) => paletteItemKey(item) === selectedKey);
  return index < 0 ? 0 : index;
}

export function buildPaletteItems(
  commits: Commit[],
  results: RepoSearchHit[],
  query: string,
  files: FileSearchHit[] = []
): PaletteItem[] {
  const exactName = query.trim().normalize("NFC").toLowerCase();
  // `106` names change request #106 as surely as a repo's full name names the
  // repo, and a bare number also looks like a commit hash prefix and a path —
  // so whatever holds #106 leads, above both.
  const prNumber = changeRequestNumberQuery(query);
  const exactRepos: RepoSearchHit[] = [];
  const otherResults: RepoSearchHit[] = [];
  for (const hit of results) {
    if (
      (hit.kind === "repo" &&
        hit.name.normalize("NFC").toLowerCase() === exactName) ||
      (prNumber !== null && hit.pr?.number === prNumber)
    ) {
      exactRepos.push(hit);
    } else {
      otherResults.push(hit);
    }
  }

  // Files sit above commits: the query that produces them is a literal path
  // substring, so a hit is a strong signal, and the main process caps the list
  // short enough that it cannot crowd the other kinds out.
  return [
    ...exactRepos.map((hit) => ({ kind: "repo" as const, hit })),
    ...files.map((hit) => ({ kind: "file" as const, hit })),
    ...commits.map((commit) => ({ kind: "commit" as const, commit })),
    ...otherResults.map((hit) => ({ kind: "repo" as const, hit }))
  ];
}

function SearchIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function CommitIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 12h6M15 12h6" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 7v10M8 17c5 0 8-2 8-7" />
    </svg>
  );
}

/** Lucide `git-pull-request`, hand-transcribed like the other glyphs here. */
function ChangeRequestIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <path d="M6 9v12" />
    </svg>
  );
}

/**
 * The hit a change request becomes once its head is here: the worktree,
 * local branch or remote ref that holds it, carrying the PR along. The
 * caller's existing path for that kind does the rest — select, or offer a
 * new worktree.
 */
export function hitForLocation(
  hit: RepoSearchHit,
  location: ChangeRequestLocation
): RepoSearchHit | null {
  // The spread carries `pr` along: the located branch is the same hit, moved.
  const base = { ...hit };
  switch (location.kind) {
    case "worktree":
      return { ...base, kind: "worktree", name: location.branch, worktreeId: location.worktreeId };
    case "local":
      return { ...base, kind: "local_branch", name: location.branch };
    case "remote":
      return {
        ...base,
        kind: "remote_branch",
        name: location.branch,
        remoteRef: location.fullName,
        remoteName: "origin"
      };
    default:
      return null;
  }
}

export function RepoSwitcherOverlay({
  commits,
  commitContext,
  onClose,
  onPick,
  onPickCommit,
  onPickFile,
  platform = currentPlatform()
}: {
  commits: Commit[];
  commitContext: {
    repoName: string;
    branch: string;
    worktreeId: string;
  } | null;
  onClose: () => void;
  onPick: (hit: RepoSearchHit) => void;
  onPickCommit: (commit: Commit) => void;
  onPickFile: (path: string) => void;
  /** Explicit only in deterministic platform component tests. */
  platform?: string;
}) {
  const now = useRelativeClock();
  const [copyStatus, setCopyStatus] = useState<{ key: string; message: string } | null>(null);
  const [menu, setMenu] = useState<{ item: PaletteItem; x: number; y: number } | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RepoSearchHit[]>([]);
  const [files, setFiles] = useState<FileSearchHit[]>([]);
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Map<string, SearchHitStatus>>(
    () => new Map()
  );
  const [lookedUpCommit, setLookedUpCommit] = useState<{
    query: string;
    commit: Commit | null;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const resolvedBranches = useRef(new Map<string, RepoSearchHit | null>());
  const [branchError, setBranchError] = useState<string | null>(null);
  const resolveBranch = useCallback(async (hit: RepoSearchHit) => {
    const r = await dispatch("search:branchWorktree", {
      repoId: hit.repoId,
      branch: hit.name
    });
    if (!r.ok) return r;
    // The worktree's own PR comes from `branch_pr`, which knows nothing of a
    // fork's `pr/N` branch — keep the one the search found.
    const resolved =
      r.value !== null && r.value.pr === undefined && hit.pr !== undefined
        ? { ...r.value, pr: hit.pr }
        : r.value;
    if (mounted.current) {
      const key = hitKey(hit);
      resolvedBranches.current.set(key, resolved);
      setResults((prev) => resolvePaletteHits(prev, resolvedBranches.current));
      if (resolved !== null) {
        const replacement = `repo:${hitKey(resolved)}`;
        setSelectedItemKey((prev) =>
          prev === `repo:${key}` ? replacement : prev
        );
      }
    }
    return ok(resolved);
  }, []);
  const idPrefix = useId();
  const resultsId = `${idPrefix}-results`;
  const rowId = (index: number): string => `${idPrefix}-result-${index}`;
  const commitWorktreeId = commitContext?.worktreeId ?? null;
  const commitResults = useMemo(
    () => searchCommits(commits, query),
    [commits, query]
  );
  const hashQuery = commitHashQuery(query);
  const directCommit =
    hashQuery !== null && lookedUpCommit?.query === hashQuery
      ? lookedUpCommit.commit
      : null;
  const allCommitResults = useMemo(
    () =>
      directCommit === null ||
      commitResults.some((commit) => commit.hash === directCommit.hash)
        ? commitResults
        : [directCommit, ...commitResults],
    [commitResults, directCommit]
  );
  const items = useMemo<PaletteItem[]>(
    () => buildPaletteItems(allCommitResults, results, query, files),
    [allCommitResults, results, query, files]
  );
  const sel = selectedPaletteItemIndex(items, selectedItemKey);
  useEffect(() => {
    setCopyStatus(null);
    setMenu(null);
  }, [query]);
  useEffect(() => {
    if (copyStatus === null) return;
    const timer = window.setTimeout(() => setCopyStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  const closeMenu = useCallback(() => {
    setMenu(null);
    inputRef.current?.focus();
  }, []);

  const copy = async (item: PaletteItem, action: CopyAction): Promise<void> => {
    const key = paletteItemKey(item);
    if (action.open === true) {
      void dispatch("shell:openExternal", { url: action.value });
      return;
    }
    try {
      await copyText(action.value);
      setCopyStatus({ key, message: "Copied" });
    } catch {
      setCopyStatus({ key, message: "Could not copy. Try again." });
    }
  };

  const rowActions = (item: PaletteItem) => {
    const key = paletteItemKey(item);
    const name = item.kind === "commit" ? item.commit.shortHash : item.hit.name;
    return (
      <>
        {copyStatus?.key === key && <span role="status" className="overlay-result__meta">{copyStatus.message}</span>}
        <button
          type="button"
          className="kebab__btn overlay-result__actions"
          tabIndex={-1}
          aria-label={`Copy actions for ${name}`}
          title={`Copy actions for ${name}`}
          aria-haspopup="menu"
          aria-expanded={menu !== null && paletteItemKey(menu.item) === key}
          onClick={(event) => {
            event.stopPropagation();
            if (menu !== null && paletteItemKey(menu.item) === key) {
              closeMenu();
              return;
            }
            menuTriggerRef.current = event.currentTarget;
            const bounds = event.currentTarget.getBoundingClientRect();
            setSelectedItemKey(key);
            setMenu({ item, x: bounds.left, y: bounds.bottom + 4 });
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="5" r="2.3" />
            <circle cx="12" cy="12" r="2.3" />
            <circle cx="12" cy="19" r="2.3" />
          </svg>
        </button>
      </>
    );
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Toggle the hit's pin optimistically; the sidebar picks up the change via
  // the handler's repo:changed event, and our copy keeps results stable (no
  // re-query, so rows don't jump while the overlay is open).
  const togglePin = (hit: RepoSearchHit) => {
    if (hasNoCheckout(hit)) return;
    const pinned = !hit.pinned;
    setResults((prev) =>
      prev.map((h) => (hitKey(h) === hitKey(hit) ? { ...h, pinned } : h))
    );
    if (hit.kind === "worktree" && hit.worktreeId !== undefined) {
      void dispatch("worktree:setPin", { worktreeId: hit.worktreeId, pinned });
    } else {
      void dispatch("repo:setPin", { repoId: hit.repoId, pinned });
    }
  };

  useEffect(() => {
    let active = true;
    // This window's profile decides the scope; main widens it only when
    // Settings → General → Search all profiles is on.
    const profileId = windowProfileId();
    void dispatch("repo:search", {
      query,
      ...(profileId === null ? {} : { profileId })
    }).then((r) => {
      if (active && r.ok) {
        setResults(resolvePaletteHits(r.value, resolvedBranches.current));
      }
    });
    return () => {
      active = false;
    };
  }, [query]);

  // Tracked files in the selected worktree. This is the only way into a file
  // that has not changed recently: the app has no file browser, so history and
  // blame were otherwise reachable only for files that turned up in a diff.
  useEffect(() => {
    if (commitWorktreeId === null || query.trim() === "") {
      setFiles([]);
      return;
    }
    let active = true;
    // Debounced like the commit lookup below: every keystroke otherwise cost an
    // IPC round trip that ranked the worktree's whole tracked-path list.
    const timer = window.setTimeout(() => {
      void dispatch("file:search", {
        worktreeId: commitWorktreeId,
        query
      }).then((result) => {
        if (active) setFiles(result.ok ? result.value : []);
      });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [commitWorktreeId, query]);

  useEffect(() => {
    if (hashQuery === null || commitWorktreeId === null) {
      setLookedUpCommit(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void dispatch("commit:lookup", {
        worktreeId: commitWorktreeId,
        hash: hashQuery
      }).then((result) => {
        if (active) {
          setLookedUpCommit({
            query: hashQuery,
            commit: result.ok ? result.value : null
          });
        }
      });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [commitWorktreeId, hashQuery]);

  // Keyboard selection remains virtual so the query keeps focus. Keep the
  // active descendant visible when arrows move beyond the scroll viewport.
  useEffect(() => {
    const selected = resultsRef.current?.querySelector(
      ".overlay-result.is-selected"
    );
    if (typeof selected?.scrollIntoView === "function") {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [sel, items.length]);

  const pickItem = (item: PaletteItem | undefined): void => {
    if (item?.kind === "commit") onPickCommit(item.commit);
    else if (item?.kind === "file") onPickFile(item.hit.path);
    else if (item?.kind === "repo") {
      if (item.hit.kind === "change_request") {
        void pickChangeRequest(item.hit);
        return;
      }
      if (item.hit.kind !== "local_branch") {
        onPick(item.hit);
        return;
      }
      pickLocalBranch(item.hit);
    }
  };

  // Enter/click can beat the visibility debounce. Resolve through the same
  // backend cache before offering to create a checkout.
  const pickLocalBranch = (hit: RepoSearchHit): void => {
    setBranchError(null);
    void resolveBranch(hit).then((result) => {
      if (!mounted.current) return;
      if (result.ok) onPick(result.value ?? hit);
      else setBranchError(result.error.message);
    });
  };

  /**
   * A change request nothing here holds: fetch its head (origin's branch, or
   * a fork's as `pr/N`), then carry on exactly as for the branch that fetch
   * produced — the New worktree offer, or the worktree if one appeared.
   */
  const [fetchingPr, setFetchingPr] = useState<string | null>(null);
  const pickChangeRequest = async (hit: RepoSearchHit): Promise<void> => {
    const pr = hit.pr;
    if (pr === undefined || fetchingPr !== null) return;
    setBranchError(null);
    setFetchingPr(hitKey(hit));
    const result = await dispatch("pr:fetchHead", {
      repoId: hit.repoId,
      number: pr.number
    });
    if (!mounted.current) return;
    setFetchingPr(null);
    if (!result.ok) {
      setBranchError(result.error.message);
      return;
    }
    const next = hitForLocation(hit, result.value);
    if (next === null) {
      setBranchError(`${changeRequestWord(hit)} #${pr.number} has no branch to check out.`);
      return;
    }
    if (next.kind === "local_branch") pickLocalBranch(next);
    else onPick(next);
  };

  /** One card for the whole result list — see `hoverTooltip`. The palette
   *  owns Escape and claims it from a React handler, which runs ahead of this
   *  hook's window listener, so dismissing the palette still beats dismissing
   *  a card that happens to be open over it. */
  const tip = useViewportTooltip();

  const selectItem = (index: number): void => {
    if (menu !== null) return;
    const item = items[index];
    setSelectedItemKey(item === undefined ? null : paletteItemKey(item));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // A nested menu may already have consumed Escape in the capture phase.
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    // Tab reaches the selected row's visible action, then returns to search.
    if (event.key === "Tab") {
      event.preventDefault();
      if (event.target === inputRef.current) {
        const button = resultsRef.current?.querySelector<HTMLButtonElement>(
          ".overlay-result.is-selected .overlay-result__actions"
        );
        (button ?? inputRef.current)?.focus();
      } else {
        inputRef.current?.focus();
      }
      return;
    }
    if ((event.target as HTMLElement).closest("button") !== null) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectItem(Math.min(sel + 1, Math.max(0, items.length - 1)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectItem(Math.max(sel - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pickItem(items[sel]);
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      event.key.toLowerCase() === "p"
    ) {
      event.preventDefault();
      const item = items[sel];
      if (item?.kind === "repo") togglePin(item.hit);
    }
  };

  // Lazily fill per-hit status (tip age + dirty/ahead/behind when cached) as
  // rows become VISIBLE — debounced so a fast scroll doesn't rip through the
  // whole list, canceled the moment a row scrolls back out. Statuses are
  // memoized for the overlay's lifetime, so revisiting a row is free.
  const fill = useMemo(
    () => createAsyncFill<string>({ concurrency: 3, debounceMs: 200 }),
    []
  );
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  useEffect(() => () => fill.cancelAll(), [fill]);
  useEffect(() => {
    const root = resultsRef.current;
    if (root === null || results.length === 0) return;
    const byKey = new Map(results.map((h) => [hitKey(h), h]));
    const observer = new IntersectionObserver(
      (obsEntries) => {
        for (const e of obsEntries) {
          const key = (e.target as HTMLElement).dataset["hitKey"];
          if (key === undefined) continue;
          if (!e.isIntersecting) {
            fill.cancel(key);
            continue;
          }
          if (statusesRef.current.has(key)) continue;
          const hit = byKey.get(key);
          if (hit === undefined) continue;
          if (hit.kind === "local_branch") {
            if (!resolvedBranches.current.has(key)) {
              fill.request(key, async () => {
                await resolveBranch(hit);
              });
            }
            continue;
          }
          if (hasNoCheckout(hit)) continue;
          fill.request(key, async () => {
            const r = await dispatch("search:status", {
              repoId: hit.repoId,
              ...(hit.worktreeId !== undefined
                ? { worktreeId: hit.worktreeId }
                : {})
            });
            if (r.ok) {
              setStatuses((prev) => new Map(prev).set(key, r.value));
            }
          });
        }
      },
      { root }
    );
    for (const el of root.querySelectorAll("[data-hit-key]")) {
      observer.observe(el);
    }
    return () => {
      observer.disconnect();
      for (const key of byKey.keys()) fill.cancel(key);
    };
  }, [results, fill, resolveBranch]);

  return (
    <div className="overlay-backdrop" onClick={onClose} onKeyDown={(event) => {
      // ContextMenu's window listener closes on Tab; retain focus in the palette.
      if (event.key === "Tab" && (event.target as HTMLElement).closest('[role="menu"]')) {
        event.preventDefault();
      }
    }}>
      <div
        className="overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to repo, branch, commit, or file"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => {
          if (event.target === inputRef.current) return;
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="overlay-search">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedItemKey(null);
              setBranchError(null);
            }}
            aria-label="Jump to repo, branch, commit, or file"
            aria-controls={items.length > 0 ? resultsId : undefined}
            aria-activedescendant={
              items.length > 0 ? rowId(sel) : undefined
            }
            autoComplete="off"
            spellCheck={false}
            placeholder="Search repos, branches, commits & files…"
          />
          <span className="kbd">esc</span>
        </div>

        {branchError !== null && (
          <div className="modal__error" role="alert">{branchError}</div>
        )}
        <div
          className="overlay-results"
          id={resultsId}
          role="listbox"
          aria-label="Repositories, branches, commits, and files"
          ref={resultsRef}
        >
          {items.map((item, i) => {
            if (item.kind === "commit") {
              const commit = item.commit;
              const rowTip = hoverTooltip(
                tip,
                commitContext === null
                  ? commit.hash
                  : `${commitContext.repoName} · ${commitContext.branch} · ${commit.hash}`
              );
              return (
                <div
                  key={`commit:${commit.hash}`}
                  id={rowId(i)}
                  role="option"
                  aria-selected={i === sel}
                  tabIndex={-1}
                  className={`overlay-result${i === sel ? " is-selected" : ""}`}
                  {...rowTip}
                  // The row already moves the selection on enter, so the card's
                  // own handler is called rather than spread over it.
                  onMouseEnter={(event) => {
                    selectItem(i);
                    rowTip.onMouseEnter(event);
                  }}
                  onClick={() => onPickCommit(commit)}
                >
                  <CommitIcon />
                  <span className="overlay-result__name">{commit.subject}</span>
                  <span className="overlay-result__meta">{commit.authorName}</span>
                  <span className="hit-status__age">
                    {shortWhen(commit.committedAt, now)}
                  </span>
                  <span className="overlay-result__profile">
                    {commit.shortHash}
                  </span>
                  {rowActions(item)}
                </div>
              );
            }
            if (item.kind === "file") {
              const file = item.hit;
              const rowTip = hoverTooltip(
                tip,
                `${file.path} — open its history and blame`
              );
              return (
                <div
                  key={`file:${file.path}`}
                  id={rowId(i)}
                  role="option"
                  aria-selected={i === sel}
                  tabIndex={-1}
                  className={`overlay-result${i === sel ? " is-selected" : ""}`}
                  {...rowTip}
                  onMouseEnter={(event) => {
                    selectItem(i);
                    rowTip.onMouseEnter(event);
                  }}
                  onClick={() => onPickFile(file.path)}
                >
                  <FileIcon />
                  <span className="overlay-result__name">{file.name}</span>
                  <span className="overlay-result__folder">
                    <span className="overlay-result__folder-name">
                      {file.dir === "" ? "repository root" : file.dir}
                    </span>
                  </span>
                  <span style={{ flex: 1 }} />
                  <span className="overlay-result__meta">file history</span>
                  {rowActions(item)}
                </div>
              );
            }
            const r = item.hit;
            return (
              // A div, not a button: the pin star inside is a real <button>,
              // and buttons can't nest.
              <div
                // Kind-prefixed: a repo and its PRIMARY worktree share the same
                // hash-of-path id, and duplicate keys strand ghost rows in the
                // DOM across re-renders.
                key={hitKey(r)}
                id={rowId(i)}
                data-hit-key={hitKey(r)}
                role="option"
                aria-selected={i === sel}
                tabIndex={-1}
                className={`overlay-result${i === sel ? " is-selected" : ""}`}
                onMouseEnter={() => selectItem(i)}
                onClick={() => pickItem(item)}
              >
              {/* The kind, said twice: once to the pointer and once to the
                  accessibility tree. The glyph carried neither, and for a
                  worktree and a repo it is the row's ONLY marker of kind —
                  `__meta` names their repo and worktree count, never the kind
                  — so a screen reader was told nothing and a sighted user got
                  a 15px mark with nothing to ask. The sr-only span is what
                  lands in the name: the row is a `role="option"`, so the name
                  comes from its subtree. Wrapped in a span rather than spread
                  onto the <svg> because `hoverTooltip`'s handlers are typed
                  for HTMLElement; the folder beside it is wrapped likewise. */}
              <span className="a11y-sr-only">{hitKindLabel(r)}</span>
              <span
                className="overlay-result__kind"
                {...hoverTooltip(tip, hitKindLabel(r))}
              >
                {isWorktreelessBranch(r) ? (
                  <BranchIcon />
                ) : r.kind === "change_request" ? (
                  <ChangeRequestIcon />
                ) : r.kind === "worktree" ? (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M6 3v12" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="6" r="3" />
                    <path d="M18 9c0 6-6 6-6 12" />
                  </svg>
                ) : (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                  </svg>
                )}
              </span>
              <span className="overlay-result__name">{r.name}</span>
              {(() => {
                const folder = hitFolderLabel(r);
                if (folder === null) return null;
                return (
                  <>
                    <span className="a11y-sr-only">in folder</span>
                    {/* The hit's name too: it is the half of the row that
                        truncates first, and this is the element the pointer is
                        over. The path stays WHOLE here, unlike the sidebar's:
                        a worktree can come back because the query matched a
                        directory deep inside its path, and this tooltip is the
                        only place that shows it — eliding the middle would
                        hide the very segment that explains the row. */}
                    <span
                      className="overlay-result__folder"
                      {...hoverTooltip(
                        tip,
                        `${r.name}\nWorktree folder — ${r.path}`
                      )}
                    >
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                      </svg>
                      <span className="overlay-result__folder-name">{folder}</span>
                    </span>
                  </>
                );
              })()}
              {!hasNoCheckout(r) && (
                <button
                  type="button"
                  className={`pin${r.pinned ? " is-pinned" : ""}`}
                  {...hoverTooltip(
                    tip,
                    r.pinned
                      ? `Unpin ${r.kind === "worktree" ? "worktree" : "repo"}`
                      : `Pin ${r.kind === "worktree" ? "worktree" : "repo"}`
                  )}
                  aria-label={
                    r.pinned
                      ? `Unpin ${r.kind === "worktree" ? "worktree" : "repo"}`
                      : `Pin ${r.kind === "worktree" ? "worktree" : "repo"}`
                  }
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePin(r);
                  }}
                >
                  <PinIcon filled={r.pinned} size={12} />
                </button>
              )}
              {r.pr !== undefined && <PrChip pr={r.pr} />}
              {(() => {
                const s = statuses.get(hitKey(r));
                if (s === undefined) return null;
                return (
                  <span className="hit-status">
                    {s.dirty !== null && s.dirty > 0 && (
                      <span className="hit-status__b hit-status__b--warn">
                        ●{s.dirty}
                      </span>
                    )}
                    {s.ahead !== null && s.ahead > 0 && (
                      <span className="hit-status__b hit-status__b--ok">
                        ↑{s.ahead}
                      </span>
                    )}
                    {s.behind !== null && s.behind > 0 && (
                      <span className="hit-status__b hit-status__b--warn">
                        ↓{s.behind}
                      </span>
                    )}
                    {s.lastActivityAt !== null && (
                      <span
                        className="hit-status__age"
                        {...hoverTooltip(tip, `Last commit ${s.lastActivityAt}`)}
                      >
                        {shortWhen(s.lastActivityAt, now)}
                      </span>
                    )}
                  </span>
                );
              })()}
              <span className="overlay-result__meta">
                {fetchingPr === hitKey(r)
                  ? "fetching…"
                  : r.kind === "remote_branch"
                  ? `${r.repoName ?? ""} · ${r.remoteName ?? "remote"}`
                  : r.kind === "local_branch"
                  ? `${r.repoName ?? ""} · no worktree`
                  : r.kind === "change_request"
                  ? `${r.repoName ?? ""} · ${r.pr?.headRepoPath !== undefined ? "fork" : "not fetched"}`
                  : r.kind === "worktree"
                  ? (r.repoName ?? "")
                  : `${r.worktreeCount} ${r.worktreeCount === 1 ? "wt" : "wts"}`}
              </span>
              <span className="overlay-result__profile">{r.profileName}</span>
              {rowActions(item)}
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="overlay-empty">
              {query.trim() === ""
                ? "No repos indexed yet"
                : `Nothing matches "${query}"`}
            </div>
          )}
        </div>

        <div className="overlay-foot">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          {items.length > 0 && <span>tab actions</span>}
          {items[sel]?.kind === "repo" &&
            !hasNoCheckout(items[sel].hit) && (
              <span>{shortcutLabel({ key: "P" }, platform)} pin</span>
            )}
          <span style={{ flex: 1 }} />
          <span>
            {items.length} {items.length === 1 ? "result" : "results"}
          </span>
        </div>
      </div>
      {tip.tooltipNode}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Copy actions for ${menu.item.kind === "commit" ? menu.item.commit.shortHash : menu.item.hit.name}`}
          triggerRef={menuTriggerRef}
          onClose={closeMenu}
          items={paletteCopyActions(menu.item).map((action) => ({
            type: "item",
            label: action.label,
            onSelect: () => void copy(menu.item, action)
          }))}
        />
      )}
    </div>
  );
}
