import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import type {
  FileBlameHunk,
  FileBlamePage,
  FileHistoryEntry,
  FileInsightContext,
  GitHubCommitAuthorIdentityLookup
} from "@pwrgit/shared";
import { fileStatusChipProps } from "../../lib/fileStatus";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { useRelativeClock } from "../../lib/useRelativeClock";
import { localWhen, shortWhen } from "../graph/graph-view";
import { DiffViewer } from "./DiffViewer";
import type { ImageDiffRevisions } from "./ImageDiff";

export type FileInsightTab = "history" | "blame";

const TAB_ORDER: readonly FileInsightTab[] = ["history", "blame"];
const TAB_LABEL: Record<FileInsightTab, string> = {
  history: "History",
  blame: "Blame"
};

/**
 * One level of the pane's drill-down stack. The base level is the file the
 * user opened; "blame before this commit" pushes the same file at an older
 * revision, which is the only way to see past a reformatting commit.
 */
type InsightScope = {
  path: string;
  context: FileInsightContext;
  /** Why this level exists. Rendered in the trail; absent on the base level. */
  via?: string;
};

/** A single commit's changes to a single file, shown without leaving the pane. */
type CommitFilePreview = {
  hash: string;
  shortHash: string;
  subject: string;
  path: string;
};

const scopeKey = (scope: InsightScope): string =>
  `${scope.context.kind === "commit" ? scope.context.hash : "working"}:${scope.path}`;

const contextLabel = (context: FileInsightContext): string =>
  context.kind === "workingTree"
    ? "Working tree · through HEAD"
    : `Commit ${context.hash.slice(0, 7)}`;

let operationSequence = 0;
const nextOperationId = (kind: FileInsightTab): string =>
  `file-${kind}-${Date.now()}-${++operationSequence}`;

type IdentityCandidate = {
  hash: string;
  authorName: string;
  authorEmail: string;
};

function useAuthorIdentities(
  worktreeId: string,
  candidates: IdentityCandidate[]
): Record<string, GitHubCommitAuthorIdentityLookup> {
  const [lookups, setLookups] = useState<
    Record<string, GitHubCommitAuthorIdentityLookup>
  >({});
  const unique = useMemo(() => {
    const commits = new Map<string, IdentityCandidate>();
    for (const candidate of candidates) commits.set(candidate.hash, candidate);
    return [...commits.values()];
  }, [candidates]);
  const key = unique.map((candidate) => candidate.hash).join(":");

  useEffect(() => {
    setLookups({});
  }, [worktreeId]);

  useEffect(() => {
    if (unique.length === 0) return;
    let active = true;
    void dispatch("github:hydrateCommitAuthorIdentities", {
      worktreeId,
      commits: unique.map((candidate) => ({
        commitHash: candidate.hash,
        authorName: candidate.authorName,
        authorEmail: candidate.authorEmail
      }))
    }).then((result) => {
      if (active && result.ok) {
        setLookups((current) => ({ ...current, ...result.value }));
      }
    });
    return () => {
      active = false;
    };
    // The hash key describes the exact identity batch; names/emails are
    // immutable commit metadata for those hashes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId, key]);

  useEffect(
    () =>
      subscribe("github:commitAuthorIdentityChanged", (payload) => {
        if (payload.worktreeId !== worktreeId) return;
        setLookups((current) => ({
          ...current,
          [payload.commitHash]: payload.lookup
        }));
      }),
    [worktreeId]
  );

  return lookups;
}

function AuthorLabel({
  hash,
  name,
  email,
  lookups
}: {
  hash: string | null;
  name: string;
  email: string;
  lookups: Record<string, GitHubCommitAuthorIdentityLookup>;
}) {
  const identity = hash === null ? undefined : lookups[hash]?.identity;
  const label = identity?.login === undefined ? name : `@${identity.login}`;
  return (
    <span className="file-insight__author" title={email || name}>
      {identity?.avatarUrl !== undefined && (
        <img src={identity.avatarUrl} alt="" className="file-insight__avatar" />
      )}
      {label}
    </span>
  );
}

function LineageIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 12h5M16 12h5" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

function RewindIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 5 3 12l6 7" />
      <path d="M3 12h11a6 6 0 0 1 0 12h-1" />
    </svg>
  );
}

/**
 * Page in the next block when the "load more" control scrolls into view.
 *
 * The control stays on screen either way: it is the keyboard affordance, the
 * fallback where IntersectionObserver is unavailable, and the retry after a
 * page that failed. Re-observing once `loading` clears is what makes this fill
 * a tall viewport — the button does not move enough to emit a fresh
 * intersection of its own, so without that the fill would stall after one page.
 */
function useAutoPaging(
  nextCursor: string | null,
  loading: boolean,
  load: (cursor: string) => void
): (node: HTMLButtonElement | null) => void {
  const [node, setNode] = useState<HTMLButtonElement | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (node === null || nextCursor === null || loading) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadRef.current(nextCursor);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, nextCursor, loading]);

  return setNode;
}

function cancelOperations(operationIds: Set<string>): void {
  for (const operationId of operationIds) {
    void dispatch("file:cancelInsight", { operationId });
  }
  operationIds.clear();
}

function HistoryView({
  worktreeId,
  path,
  context,
  onOpenCommitFile,
  onShowCommit
}: {
  worktreeId: string;
  path: string;
  context: FileInsightContext;
  onOpenCommitFile: (preview: CommitFilePreview) => void;
  onShowCommit: (hash: string, subject: string) => void;
}) {
  const [entries, setEntries] = useState<FileHistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeOperations = useRef(new Set<string>());
  const now = useRelativeClock();
  const identities = useAuthorIdentities(
    worktreeId,
    useMemo(
      () =>
        entries.map((entry) => ({
          hash: entry.hash,
          authorName: entry.authorName,
          authorEmail: entry.authorEmail
        })),
      [entries]
    )
  );

  const load = (cursor?: string): void => {
    const operationId = nextOperationId("history");
    activeOperations.current.add(operationId);
    setLoading(true);
    setError(null);
    void dispatch("file:history", {
      operationId,
      worktreeId,
      path,
      context,
      ...(cursor === undefined ? {} : { cursor })
    }).then((result) => {
      if (!activeOperations.current.delete(operationId)) return;
      if (!result.ok) {
        setError(result.error.message);
        setLoading(false);
        return;
      }
      setEntries((current) =>
        cursor === undefined
          ? result.value.entries
          : [...current, ...result.value.entries]
      );
      setNextCursor(result.value.nextCursor);
      setLoading(false);
    });
  };

  const moreRef = useAutoPaging(nextCursor, loading, load);

  useEffect(() => {
    load();
    return () => cancelOperations(activeOperations.current);
    // A fresh mounted view owns one immutable file/context tuple.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (entries.length === 0 && loading) {
    return <div className="file-insight__empty">Loading file history…</div>;
  }
  if (entries.length === 0 && error !== null) {
    return (
      <div className="file-insight__empty file-insight__empty--error" role="alert">
        <span>File history couldn’t be loaded. {error}</span>
        <button onClick={() => load()}>Retry</button>
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="file-insight__empty">
        No committed history was found for this path.
      </div>
    );
  }

  return (
    <div className="file-history" data-testid="file-history">
      {entries.map((entry) => (
        <div className="file-history__row" key={entry.hash}>
          {/* The row itself opens the diff. Reading a file's history to find
              out WHAT changed is the whole point; making that the row's own
              click keeps the tiny hash pill from being the only target. */}
          <button
            className="file-history__open"
            onClick={() =>
              onOpenCommitFile({
                hash: entry.hash,
                shortHash: entry.shortHash,
                subject: entry.subject,
                path: entry.path
              })
            }
            aria-label={`Show what ${entry.shortHash} changed in ${entry.path}`}
            title="Show what this commit changed in this file"
          >
            <span {...fileStatusChipProps(entry.status)}>{entry.status}</span>
            <span className="file-history__content">
              <span className="file-history__title">
                <span className="file-insight__commit is-static">
                  {entry.shortHash}
                </span>
                <span className="file-history__subject">{entry.subject}</span>
                <AuthorLabel
                  hash={entry.hash}
                  name={entry.authorName}
                  email={entry.authorEmail}
                  lookups={identities}
                />
                <span
                  className="file-insight__time"
                  title={localWhen(entry.committedAt)}
                >
                  {shortWhen(entry.committedAt, now)}
                </span>
              </span>
              {/* A second line only where there is something to say. Repeating
                  the file's own path once per row was noise, and reserving the
                  line for it halved how much history fitted on screen. */}
              {entry.previousPath !== undefined && (
                <span className="file-history__meta">
                  <span
                    className="file-history__rename"
                    title={`Renamed from ${entry.previousPath}`}
                  >
                    {entry.previousPath} → {entry.path}
                  </span>
                </span>
              )}
            </span>
          </button>
          <button
            className="file-insight__row-action"
            onClick={() => onShowCommit(entry.hash, entry.subject)}
            aria-label={`Show commit ${entry.shortHash} in lineage`}
            title="Show this commit in the lineage"
          >
            <LineageIcon />
          </button>
        </div>
      ))}
      {error !== null && (
        <div className="file-insight__page-error" role="alert">
          More history couldn’t be loaded. {error}
        </div>
      )}
      {nextCursor !== null && (
        <button
          ref={moreRef}
          className="file-insight__more"
          disabled={loading}
          onClick={() => load(nextCursor)}
        >
          {loading ? "Loading…" : "Load older commits"}
        </button>
      )}
    </div>
  );
}

function unavailableMessage(page: FileBlamePage): string | null {
  if (page.unavailableReason === "binary") {
    return "Blame isn’t available for binary files.";
  }
  if (page.unavailableReason === "too_large") {
    const size =
      page.bytes === null
        ? "This file"
        : `This file (${(page.bytes / 1_000_000).toFixed(1)} MB)`;
    return `${size} is over the 1 MB blame limit, so it was not loaded.`;
  }
  if (page.unavailableReason === "missing") {
    return "This file does not exist in the selected context.";
  }
  return null;
}

function blameCandidates(hunks: FileBlameHunk[]): IdentityCandidate[] {
  return hunks.flatMap((hunk) =>
    hunk.hash === null
      ? []
      : [
          {
            hash: hunk.hash,
            authorName: hunk.authorName,
            authorEmail: hunk.authorEmail
          }
        ]
  );
}

function BlameView({
  worktreeId,
  path,
  context,
  onOpenCommitFile,
  onShowCommit,
  onBlameBefore
}: {
  worktreeId: string;
  path: string;
  context: FileInsightContext;
  onOpenCommitFile: (preview: CommitFilePreview) => void;
  onShowCommit: (hash: string, subject: string) => void;
  onBlameBefore: (hunk: FileBlameHunk) => void;
}) {
  const [pages, setPages] = useState<FileBlamePage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeOperations = useRef(new Set<string>());
  const now = useRelativeClock();
  const hunks = useMemo(() => pages.flatMap((page) => page.hunks), [pages]);
  const identities = useAuthorIdentities(
    worktreeId,
    useMemo(() => blameCandidates(hunks), [hunks])
  );

  const load = (cursor?: string): void => {
    const operationId = nextOperationId("blame");
    activeOperations.current.add(operationId);
    setLoading(true);
    setError(null);
    void dispatch("file:blame", {
      operationId,
      worktreeId,
      path,
      context,
      ...(cursor === undefined ? {} : { cursor })
    }).then((result) => {
      if (!activeOperations.current.delete(operationId)) return;
      if (!result.ok) {
        setError(result.error.message);
        setLoading(false);
        return;
      }
      setPages((current) =>
        cursor === undefined ? [result.value] : [...current, result.value]
      );
      setNextCursor(result.value.nextCursor);
      setLoading(false);
    });
  };

  const moreRef = useAutoPaging(nextCursor, loading, load);

  useEffect(() => {
    load();
    return () => cancelOperations(activeOperations.current);
    // A fresh mounted view owns one immutable file/context tuple.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (pages.length === 0 && loading) {
    return <div className="file-insight__empty">Loading blame…</div>;
  }
  if (pages.length === 0 && error !== null) {
    return (
      <div className="file-insight__empty file-insight__empty--error" role="alert">
        <span>Blame couldn’t be loaded. {error}</span>
        <button onClick={() => load()}>Retry</button>
      </div>
    );
  }
  const first = pages[0];
  if (first === undefined) return null;
  const unavailable = unavailableMessage(first);
  if (unavailable !== null) {
    return <div className="file-insight__empty">{unavailable}</div>;
  }

  return (
    <div className="file-blame" data-testid="file-blame">
      {first.notice !== undefined && (
        <div className="file-insight__notice" role="status">
          {first.notice}
        </div>
      )}
      {hunks.length === 0 && (
        <div className="file-insight__empty">This file has no lines to blame.</div>
      )}
      {/* ONE horizontal scroller for the whole file. Per-hunk scrollers let a
          long line slide under its neighbours and the code stopped lining up. */}
      <div className="file-blame__lines">
        <div className="file-blame__body">
          {hunks.map((hunk, hunkIndex) => {
            const hash = hunk.hash;
            return hunk.lines.map((line, offset) => {
              const lineNumber = hunk.startLine + offset;
              const opensHunk = offset === 0;
              const classes = [
                "file-blame__row",
                opensHunk ? "is-hunk-start" : "",
                hunk.uncommitted ? "is-uncommitted" : "",
                hunkIndex % 2 === 1 ? "is-alt" : ""
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <div className={classes} key={`${lineNumber}:${hash ?? "wip"}`}>
                  {/* Blame metadata belongs in a gutter, not in a card header
                      per hunk: real files run 2–3 lines per commit, and a card
                      apiece spent more vertical space on chrome than on code. */}
                  <span className="file-blame__gutter">
                    {opensHunk && hash === null && (
                      <span className="file-insight__commit is-uncommitted">
                        WIP
                      </span>
                    )}
                    {opensHunk && hash !== null && (
                      <>
                        <button
                          className="file-insight__commit"
                          onClick={() =>
                            onOpenCommitFile({
                              hash,
                              shortHash: hunk.shortHash ?? hash.slice(0, 7),
                              subject: hunk.subject,
                              path: hunk.sourcePath === "" ? path : hunk.sourcePath
                            })
                          }
                          aria-label={`Show what ${hunk.shortHash ?? ""} changed in ${
                            hunk.sourcePath === "" ? path : hunk.sourcePath
                          }`}
                          title={`${hunk.subject} — show what this commit changed here`}
                        >
                          {hunk.shortHash}
                        </button>
                        <AuthorLabel
                          hash={hash}
                          name={hunk.authorName}
                          email={hunk.authorEmail}
                          lookups={identities}
                        />
                        {hunk.committedAt !== null && (
                          <span
                            className="file-insight__time"
                            title={localWhen(hunk.committedAt)}
                          >
                            {shortWhen(hunk.committedAt, now)}
                          </span>
                        )}
                        <span className="file-blame__actions">
                          <button
                            className="file-insight__row-action"
                            onClick={() => onBlameBefore(hunk)}
                            aria-label={`Blame ${
                              hunk.sourcePath === "" ? path : hunk.sourcePath
                            } before ${hunk.shortHash ?? ""}`}
                            title="Blame this file just before this commit"
                          >
                            <RewindIcon />
                          </button>
                          <button
                            className="file-insight__row-action"
                            onClick={() => onShowCommit(hash, hunk.subject)}
                            aria-label={`Show commit ${hunk.shortHash ?? ""} in lineage`}
                            title="Show this commit in the lineage"
                          >
                            <LineageIcon />
                          </button>
                        </span>
                      </>
                    )}
                  </span>
                  <span className="file-blame__number">{lineNumber}</span>
                  <code className="file-blame__code">{line || " "}</code>
                  {opensHunk &&
                    hunk.sourcePath !== "" &&
                    hunk.sourcePath !== path && (
                      <span className="file-blame__source">
                        from {hunk.sourcePath}
                      </span>
                    )}
                </div>
              );
            });
          })}
        </div>
      </div>
      {error !== null && (
        <div className="file-insight__page-error" role="alert">
          More blame lines couldn’t be loaded. {error}
        </div>
      )}
      {nextCursor !== null && (
        <button
          ref={moreRef}
          className="file-insight__more"
          disabled={loading}
          onClick={() => load(nextCursor)}
        >
          {loading ? "Loading…" : "Load more lines"}
        </button>
      )}
    </div>
  );
}

/** One commit's changes to one file, shown inside the pane so reading a file's
 *  history never costs the reader their place in it. */
function CommitFileDiffView({
  worktreeId,
  preview,
  onShowCommit
}: {
  worktreeId: string;
  preview: CommitFilePreview;
  onShowCommit: (hash: string, subject: string) => void;
}) {
  const [patch, setPatch] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void dispatch("diff:commitFile", {
      worktreeId,
      hash: preview.hash,
      path: preview.path
    }).then((result) => {
      if (!active) return;
      if (result.ok) setPatch(result.value);
      else setError(result.error.message);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [worktreeId, preview.hash, preview.path]);

  const images: ImageDiffRevisions = useMemo(
    () => ({
      worktreeId,
      before: { kind: "commitParent", hash: preview.hash },
      after: { kind: "commit", hash: preview.hash }
    }),
    [worktreeId, preview.hash]
  );

  return (
    <div className="file-insight-diff" data-testid="file-insight-diff">
      <div className="file-insight-diff__head">
        <span className="file-insight__commit is-static">
          {preview.shortHash}
        </span>
        <span className="file-insight-diff__subject" title={preview.subject}>
          {preview.subject}
        </span>
        <button
          className="file-insight__row-action"
          onClick={() => onShowCommit(preview.hash, preview.subject)}
          aria-label={`Show commit ${preview.shortHash} in lineage`}
          title="Show this commit in the lineage"
        >
          <LineageIcon />
        </button>
      </div>
      <div className="file-insight-diff__body">
        {loading ? (
          <div className="diff-empty">Loading diff…</div>
        ) : error !== null ? (
          <div className="file-insight__empty file-insight__empty--error" role="alert">
            That commit’s diff couldn’t be loaded. {error}
          </div>
        ) : (
          <DiffViewer
            patch={patch}
            images={images}
            emptyLabel={`${preview.shortHash} made no textual change to this file.`}
          />
        )}
      </div>
    </div>
  );
}

export function FileInsightsPane({
  worktreeId,
  path,
  context,
  initialTab,
  returnLabel = "Diff",
  onClose,
  onShowCommit
}: {
  worktreeId: string;
  path: string;
  context: FileInsightContext;
  initialTab: FileInsightTab;
  /** What closing the pane returns to — a diff when it was opened from one,
   *  the lineage when it was opened from the command palette. */
  returnLabel?: string;
  onClose: () => void;
  onShowCommit: (hash: string, subject: string) => boolean;
}) {
  const [tab, setTab] = useState<FileInsightTab>(initialTab);
  // Panels stay mounted once opened, so flipping between History and Blame
  // costs no Git read and keeps each list's scroll position. Only the tab the
  // reader has actually asked for is ever mounted.
  const [opened, setOpened] = useState<readonly FileInsightTab[]>(() => [
    initialTab
  ]);
  const [scopes, setScopes] = useState<readonly InsightScope[]>(() => [
    { path, context }
  ]);
  const [preview, setPreview] = useState<CommitFilePreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const paneRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Partial<Record<FileInsightTab, HTMLButtonElement>>>({});
  const idPrefix = useId();
  const tabId = (value: FileInsightTab): string => `${idPrefix}-tab-${value}`;
  const panelId = (value: FileInsightTab): string => `${idPrefix}-panel-${value}`;

  const scope = scopes[scopes.length - 1] ?? { path, context };
  const depth = scopes.length;
  // Focus follows the level, so Escape keeps working after a click whose
  // button unmounted with the level it lived on.
  const levelKey = `${depth}:${scopeKey(scope)}:${preview?.hash ?? ""}:${
    preview?.path ?? ""
  }`;

  const selectTab = useCallback((next: FileInsightTab): void => {
    setTab(next);
    setOpened((current) =>
      current.includes(next) ? current : [...current, next]
    );
  }, []);

  const pushScope = useCallback(
    (next: InsightScope, nextTab: FileInsightTab): void => {
      setNotice(null);
      setPreview(null);
      setScopes((current) => [...current, next]);
      setTab(nextTab);
      setOpened([nextTab]);
    },
    []
  );

  // One back verb for the whole pane: it closes the commit diff, then unwinds
  // the blame drill-down, then leaves for the diff that opened the pane.
  const goBack = useCallback((): void => {
    setNotice(null);
    if (preview !== null) {
      setPreview(null);
      return;
    }
    if (scopes.length > 1) {
      setScopes((current) => current.slice(0, -1));
      setOpened([tab]);
      return;
    }
    onClose();
  }, [preview, scopes.length, tab, onClose]);

  const backLabel =
    preview !== null
      ? `‹ ${TAB_LABEL[tab]}`
      : scopes.length > 1
        ? "‹ Back"
        : `‹ ${returnLabel}`;

  useEffect(() => {
    paneRef.current?.focus({ preventScroll: true });
  }, [levelKey]);

  // Escape is scoped to focus inside the pane and deferred a tick, matching
  // DiffPane: an overlay that claims the key with preventDefault still wins.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (paneRef.current?.contains(document.activeElement) !== true) return;
      window.setTimeout(() => {
        if (!event.defaultPrevented) goBack();
      }, 0);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goBack]);

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const index = TAB_ORDER.indexOf(tab);
    const last = TAB_ORDER.length - 1;
    const target =
      event.key === "ArrowRight"
        ? TAB_ORDER[index === last ? 0 : index + 1]
        : event.key === "ArrowLeft"
          ? TAB_ORDER[index === 0 ? last : index - 1]
          : event.key === "Home"
            ? TAB_ORDER[0]
            : event.key === "End"
              ? TAB_ORDER[last]
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    selectTab(target);
    tabRefs.current[target]?.focus();
  };

  const showCommit = (hash: string, subject: string): boolean => {
    const revealed = onShowCommit(hash, subject);
    setNotice(
      revealed
        ? null
        : "That commit is older than the loaded lineage window. File details remain open."
    );
    return revealed;
  };

  const openCommitFile = (next: CommitFilePreview): void => {
    setNotice(null);
    setPreview(next);
  };

  const blameBefore = (hunk: FileBlameHunk): void => {
    const hash = hunk.hash;
    if (hash === null) return;
    const short = hunk.shortHash ?? hash.slice(0, 7);
    void dispatch("commit:lookup", { worktreeId, hash }).then((result) => {
      const parent = result.ok ? result.value?.parents[0] : undefined;
      if (parent === undefined) {
        setNotice(
          `${short} has no parent commit — these lines are this file’s first revision.`
        );
        return;
      }
      pushScope(
        {
          path: hunk.sourcePath === "" ? scope.path : hunk.sourcePath,
          context: { kind: "commit", hash: parent },
          via: `before ${short}`
        },
        "blame"
      );
    });
  };

  return (
    <section
      className="file-insight-pane"
      aria-label={`File details — ${scope.path}`}
      ref={paneRef}
      tabIndex={-1}
    >
      <header className="file-insight-pane__head">
        <button className="file-insight-pane__back" onClick={goBack}>
          {backLabel}
        </button>
        <span className="file-insight-pane__path" title={scope.path}>
          {scope.path}
        </span>
        <span className="file-insight-pane__context">
          {contextLabel(scope.context)}
        </span>
      </header>
      {scope.via !== undefined && (
        <div className="file-insight-pane__trail">
          Showing this file {scope.via}
        </div>
      )}
      <div
        className="file-insight-tabs"
        role="tablist"
        aria-label="File details"
        onKeyDown={onTabKeyDown}
      >
        {TAB_ORDER.map((value) => (
          <button
            key={value}
            id={tabId(value)}
            role="tab"
            type="button"
            ref={(element) => {
              if (element === null) delete tabRefs.current[value];
              else tabRefs.current[value] = element;
            }}
            aria-selected={tab === value}
            aria-controls={panelId(value)}
            // Roving tab stop: the tablist is one Tab stop, arrows move within.
            tabIndex={tab === value ? 0 : -1}
            className={tab === value ? "is-active" : ""}
            onClick={() => selectTab(value)}
          >
            {TAB_LABEL[value]}
          </button>
        ))}
      </div>
      <div className="file-insight-pane__body">
        {notice !== null && (
          <div className="file-insight__notice" role="alert">
            {notice}
          </div>
        )}
        {preview !== null && (
          <CommitFileDiffView
            worktreeId={worktreeId}
            preview={preview}
            onShowCommit={showCommit}
          />
        )}
        {/* The list stays mounted underneath the commit diff. Unmounting it
            re-ran `git log --follow` and dropped the reader's scroll on the
            way back — the exact cost this drill-down exists to avoid. */}
        {TAB_ORDER.map((value) =>
            !opened.includes(value) ? null : (
              <div
                key={`${scopeKey(scope)}:${value}`}
                id={panelId(value)}
                role="tabpanel"
                aria-labelledby={tabId(value)}
                hidden={preview !== null || tab !== value}
              >
                {value === "history" ? (
                  <HistoryView
                    worktreeId={worktreeId}
                    path={scope.path}
                    context={scope.context}
                    onOpenCommitFile={openCommitFile}
                    onShowCommit={showCommit}
                  />
                ) : (
                  <BlameView
                    worktreeId={worktreeId}
                    path={scope.path}
                    context={scope.context}
                    onOpenCommitFile={openCommitFile}
                    onShowCommit={showCommit}
                    onBlameBefore={blameBefore}
                  />
                )}
              </div>
            )
        )}
      </div>
    </section>
  );
}
