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
  FileBlameUnavailableReason,
  FileContents,
  FileHistoryEntry,
  FileInsightContext,
  GitHubCommitAuthorIdentityLookup
} from "@pwrgit/shared";
import { fileStatusChipProps, fileStatusLabel } from "../../lib/fileStatus";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { useAutoPaging } from "../../lib/useAutoPaging";
import { useRelativeClock } from "../../lib/useRelativeClock";
import { localWhen, shortWhen } from "../graph/graph-view";
import { DiffViewer } from "./DiffViewer";
import type { ImageDiffRevisions } from "./ImageDiff";

export type FileInsightTab = "history" | "blame" | "contents";

const TAB_ORDER: readonly FileInsightTab[] = ["history", "blame", "contents"];
const TAB_LABEL: Record<FileInsightTab, string> = {
  history: "History",
  blame: "Blame",
  contents: "File"
};

/** How many more contents lines each "load more" reveals. Display-only: the
 *  file arrives whole (capped at 1 MB by the server) and this paces the DOM. */
const CONTENTS_REVEAL_LINES = 400;

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
  /** Land blame with this line in view — the line the reader came from. */
  line?: number;
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
    }).then(
      (result) => {
        if (active && result.ok) {
          setLookups((current) => ({ ...current, ...result.value }));
        }
      },
      // Identities are decoration: a failure leaves the Git author name in
      // place. Swallowed on purpose, but swallowed — not left unhandled.
      () => undefined
    );
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

/* The commit glyph the palette already uses, at the size it uses it. Drawn at
   12px with a 3.2-unit circle it came out as a ~3px ring with two 2px ticks —
   present in the DOM, invisible on screen. */
function LineageIcon() {
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

function EyeIcon() {
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
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function RewindIcon() {
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
      <path d="M9 5 3 12l6 7" />
      <path d="M3 12h11a6 6 0 0 1 0 12h-1" />
    </svg>
  );
}

/**
 * `dispatch` answers command failures with an err Result, but preload hands
 * back `ipcRenderer.invoke` uncaught, so a TRANSPORT failure rejects instead.
 * A rejection that nobody handles never releases the in-flight guard, and the
 * view then refuses every retry and sits on its spinner forever — so every
 * read here settles through this, whichever way it ends.
 */
function settledMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
  onShowCommit,
  onViewFile
}: {
  worktreeId: string;
  path: string;
  context: FileInsightContext;
  onOpenCommitFile: (preview: CommitFilePreview) => void;
  onShowCommit: (hash: string, subject: string) => void;
  onViewFile: (entry: FileHistoryEntry) => void;
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
    // `loading` is state, so it has not rendered yet when a click lands in the
    // same tick the observer fires — both would dispatch and both pages would
    // be appended. This set is the synchronous gate the button cannot be, and
    // the effect's cleanup clears it: a separate ref did NOT survive
    // StrictMode's mount/cleanup/mount, so the second pass saw a request still
    // "in flight", never dispatched, and the view sat on its spinner forever.
    if (activeOperations.current.size > 0) return;
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
    }).then(
      (result) => {
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
      },
      (cause: unknown) => {
        if (!activeOperations.current.delete(operationId)) return;
        setError(settledMessage(cause));
        setLoading(false);
      }
    );
  };

  const moreRef = useAutoPaging(nextCursor, loading, error, load);

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
            // The chip's own label is inside this button, and aria-label on a
            // button replaces its contents for name computation — so the change
            // kind has to be said here or it is not announced at all.
            aria-label={`${fileStatusLabel(entry.status)}: show what ${
              entry.shortHash
            } changed in ${entry.path}`}
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
              {/* A second line only where there is something to say: the
                  rename itself, and the older commits that still lived under
                  the previous name. Repeating the file's CURRENT path on every
                  row was noise, and reserving the line for it halved how much
                  history fitted on screen. */}
              {(entry.previousPath !== undefined || entry.path !== path) && (
                <span className="file-history__meta">
                  <span
                    className="file-history__rename"
                    title={
                      entry.previousPath === undefined
                        ? `This commit is under ${entry.path}`
                        : `Renamed from ${entry.previousPath}`
                    }
                  >
                    {entry.previousPath === undefined
                      ? entry.path
                      : `${entry.previousPath} → ${entry.path}`}
                  </span>
                </span>
              )}
            </span>
          </button>
          <button
            className="file-insight__row-action"
            onClick={() => onViewFile(entry)}
            aria-label={`View ${entry.path} as of ${entry.shortHash}`}
            title="View the file as of this commit"
          >
            <EyeIcon />
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

function unavailableMessage(
  page: {
    unavailableReason?: FileBlameUnavailableReason;
    bytes: number | null;
  },
  // The caps are shared with blame on purpose; the WORDING must not be. The
  // File tab saying "Blame isn't available" told the user the wrong feature
  // failed.
  surface: "blame" | "contents"
): string | null {
  if (page.unavailableReason === "binary") {
    return surface === "blame"
      ? "Blame isn’t available for binary files."
      : "Binary files don’t have a text view.";
  }
  if (page.unavailableReason === "too_large") {
    const size =
      page.bytes === null
        ? "This file"
        : `This file (${(page.bytes / 1_000_000).toFixed(1)} MB)`;
    return surface === "blame"
      ? `${size} is over the 1 MB blame limit, so it was not loaded.`
      : `${size} is over the 1 MB view limit, so it was not loaded.`;
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
  initialLine,
  onOpenCommitFile,
  onShowCommit,
  onBlameBefore
}: {
  worktreeId: string;
  path: string;
  context: FileInsightContext;
  /** Open with this line in view — where the reader was before they asked. */
  initialLine?: number;
  onOpenCommitFile: (preview: CommitFilePreview) => void;
  onShowCommit: (hash: string, subject: string) => void;
  onBlameBefore: (hunk: FileBlameHunk) => void;
}) {
  const aimedLine = initialLine ?? null;
  const [pages, setPages] = useState<FileBlamePage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Which edge failed matters: a top (prepend) failure must not read as a
  // bottom failure, and must not halt downward auto-paging.
  const [error, setError] = useState<{
    edge: "top" | "bottom";
    message: string;
  } | null>(null);
  const activeOperations = useRef(new Set<string>());
  const containerRef = useRef<HTMLDivElement>(null);
  const revealed = useRef(false);
  const now = useRelativeClock();
  const hunks = useMemo(() => pages.flatMap((page) => page.hunks), [pages]);
  const identities = useAuthorIdentities(
    worktreeId,
    useMemo(() => blameCandidates(hunks), [hunks])
  );

  // The page above the earliest loaded one, straight from the server — the
  // renderer keeps no cursor arithmetic of its own. The server also clamps an
  // aim past EOF to the last real page, so an aimed load cannot fail for
  // being aimed; a failed load is a real failure.
  const previousCursor = pages[0]?.previousCursor ?? null;

  const load = (cursor?: string, mode: "append" | "prepend" = "append"): void => {
    // `loading` is state, so it has not rendered yet when a click lands in the
    // same tick the observer fires — both would dispatch and both pages would
    // be appended. This set is the synchronous gate the button cannot be, and
    // the effect's cleanup clears it: a separate ref did NOT survive
    // StrictMode's mount/cleanup/mount, so the second pass saw a request still
    // "in flight", never dispatched, and the view sat on its spinner forever.
    if (activeOperations.current.size > 0) return;
    const operationId = nextOperationId("blame");
    activeOperations.current.add(operationId);
    setLoading(true);
    setError(null);
    void dispatch("file:blame", {
      operationId,
      worktreeId,
      path,
      context,
      ...(cursor === undefined ? {} : { cursor }),
      ...(cursor === undefined && aimedLine !== null
        ? { aimLine: aimedLine }
        : {})
    }).then(
      (result) => {
        if (!activeOperations.current.delete(operationId)) return;
        if (!result.ok) {
          setError({
            edge: mode === "prepend" ? "top" : "bottom",
            message: result.error.message
          });
          setLoading(false);
          return;
        }
        if (mode === "prepend") {
          setPages((current) => [result.value, ...current]);
          // The bottom edge did not move, so nextCursor stays untouched.
          setLoading(false);
          return;
        }
        setPages((current) =>
          cursor === undefined ? [result.value] : [...current, result.value]
        );
        setNextCursor(result.value.nextCursor);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!activeOperations.current.delete(operationId)) return;
        setError({
          edge: mode === "prepend" ? "top" : "bottom",
          message: settledMessage(cause)
        });
        setLoading(false);
      }
    );
  };

  // Only a BOTTOM-edge failure pauses downward auto-paging; a failed prepend
  // is the top edge's problem and reports there.
  const moreRef = useAutoPaging(
    nextCursor,
    loading,
    error?.edge === "bottom" ? error.message : null,
    load
  );

  useEffect(() => {
    load();
    return () => cancelOperations(activeOperations.current);
    // A fresh mounted view owns one immutable file/context/aim tuple.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bring the line the reader came from into view, once, when it exists.
  useEffect(() => {
    if (revealed.current || aimedLine === null || pages.length === 0) return;
    revealed.current = true;
    const row = containerRef.current?.querySelector(
      `[data-line="${aimedLine}"]`
    );
    // Guarded as the palette guards it: jsdom elements carry no scrollIntoView.
    if (typeof row?.scrollIntoView === "function") {
      row.scrollIntoView({ block: "center" });
    }
  }, [pages, aimedLine]);

  if (pages.length === 0 && loading) {
    return <div className="file-insight__empty">Loading blame…</div>;
  }
  if (pages.length === 0 && error !== null) {
    return (
      <div className="file-insight__empty file-insight__empty--error" role="alert">
        <span>Blame couldn’t be loaded. {error.message}</span>
        <button onClick={() => load()}>Retry</button>
      </div>
    );
  }
  const first = pages[0];
  if (first === undefined) return null;
  const unavailable = unavailableMessage(first, "blame");
  if (unavailable !== null) {
    return <div className="file-insight__empty">{unavailable}</div>;
  }

  return (
    <div className="file-blame" data-testid="file-blame" ref={containerRef}>
      {first.notice !== undefined && (
        <div className="file-insight__notice" role="status">
          {first.notice}
        </div>
      )}
      {error !== null && error.edge === "top" && (
        <div className="file-insight__page-error" role="alert">
          Earlier blame lines couldn’t be loaded. {error.message}
        </div>
      )}
      {previousCursor !== null && (
        <button
          className="file-insight__more file-insight__more--earlier"
          disabled={loading}
          onClick={() => load(previousCursor, "prepend")}
        >
          {loading ? "Loading…" : "Load earlier lines"}
        </button>
      )}
      {hunks.length === 0 ? (
        <div className="file-insight__empty">This file has no lines to blame.</div>
      ) : (
      /* ONE horizontal scroller for the whole file. Per-hunk scrollers let a
         long line slide under its neighbours and the code stopped lining up. */
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
                hunkIndex % 2 === 1 ? "is-alt" : "",
                lineNumber === aimedLine ? "is-target" : ""
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <div
                  className={classes}
                  key={`${lineNumber}:${hash ?? "wip"}`}
                  data-line={lineNumber}
                >
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
      )}
      {error !== null && error.edge === "bottom" && (
        <div className="file-insight__page-error" role="alert">
          More blame lines couldn’t be loaded. {error.message}
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

/** The file itself, at the scope's revision — history shows what each commit
 *  changed; this shows what the file WAS. Same caps and fallbacks as blame,
 *  because both ride the same content resolution in the main process. The
 *  file arrives WHOLE (the 1 MB cap bounds it); "load more" only paces how
 *  many rows the DOM holds, so scrolling costs no further Git reads. */
function ContentsView({
  worktreeId,
  path,
  context
}: {
  worktreeId: string;
  path: string;
  context: FileInsightContext;
}) {
  const [contents, setContents] = useState<FileContents | null>(null);
  const [shown, setShown] = useState(CONTENTS_REVEAL_LINES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeOperations = useRef(new Set<string>());

  const load = (): void => {
    if (activeOperations.current.size > 0) return;
    const operationId = nextOperationId("contents");
    activeOperations.current.add(operationId);
    setLoading(true);
    setError(null);
    void dispatch("file:contents", {
      operationId,
      worktreeId,
      path,
      context
    }).then(
      (result) => {
        if (!activeOperations.current.delete(operationId)) return;
        if (!result.ok) {
          setError(result.error.message);
          setLoading(false);
          return;
        }
        setContents(result.value);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!activeOperations.current.delete(operationId)) return;
        setError(settledMessage(cause));
        setLoading(false);
      }
    );
  };

  const total = contents?.lines.length ?? 0;
  const revealCursor = shown < total ? String(shown) : null;
  const moreRef = useAutoPaging(revealCursor, loading, error, () =>
    setShown((current) => current + CONTENTS_REVEAL_LINES)
  );

  useEffect(() => {
    load();
    return () => cancelOperations(activeOperations.current);
    // A fresh mounted view owns one immutable file/context tuple.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (contents === null && loading) {
    return <div className="file-insight__empty">Loading file…</div>;
  }
  if (contents === null && error !== null) {
    return (
      <div className="file-insight__empty file-insight__empty--error" role="alert">
        <span>The file couldn’t be loaded. {error}</span>
        <button onClick={() => load()}>Retry</button>
      </div>
    );
  }
  if (contents === null) return null;
  const unavailable = unavailableMessage(contents, "contents");
  if (unavailable !== null) {
    return <div className="file-insight__empty">{unavailable}</div>;
  }

  return (
    <div className="file-contents" data-testid="file-contents">
      {contents.notice !== undefined && (
        <div className="file-insight__notice" role="status">
          {contents.notice}
        </div>
      )}
      {total === 0 ? (
        <div className="file-insight__empty">This file is empty.</div>
      ) : (
        <div className="file-blame__lines">
          <div className="file-blame__body">
            {contents.lines.slice(0, shown).map((line, index) => (
              <div className="file-contents__row" key={index + 1}>
                <span className="file-blame__number">{index + 1}</span>
                <code className="file-blame__code">{line || " "}</code>
              </div>
            ))}
          </div>
        </div>
      )}
      {revealCursor !== null && (
        <button
          ref={moreRef}
          className="file-insight__more"
          onClick={() => setShown((current) => current + CONTENTS_REVEAL_LINES)}
        >
          Show more lines
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
    }).then(
      (result) => {
        if (!active) return;
        if (result.ok) setPatch(result.value);
        else setError(result.error.message);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(settledMessage(cause));
        setLoading(false);
      }
    );
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
  initialLine,
  returnLabel = "Diff",
  onClose,
  onShowCommit
}: {
  worktreeId: string;
  path: string;
  context: FileInsightContext;
  initialTab: FileInsightTab;
  /** Open blame with this line in view — the line the reader came from. */
  initialLine?: number;
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
    { path, context, ...(initialLine === undefined ? {} : { line: initialLine }) }
  ]);
  const [preview, setPreview] = useState<CommitFilePreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const paneRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Partial<Record<FileInsightTab, HTMLButtonElement>>>({});
  const pendingBlameBefore = useRef(false);
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
    // Picking a tab means "show me that". With a commit diff open over the
    // panels, leaving it there made the tab look dead — it flipped
    // aria-selected onto a panel the reader could not see.
    setPreview(null);
    setTab(next);
    setOpened((current) =>
      current.includes(next) ? current : [...current, next]
    );
  }, []);

  // Each drill-down frame remembers the tab it was entered FROM, so Back
  // returns there: the eye action jumps History → File, and without this the
  // pop landed on the base scope's File tab with the history list unmounted.
  const fromTabs = useRef<FileInsightTab[]>([]);
  const pushScope = useCallback(
    (next: InsightScope, nextTab: FileInsightTab): void => {
      setNotice(null);
      setPreview(null);
      fromTabs.current.push(tab);
      setScopes((current) => [...current, next]);
      setTab(nextTab);
      setOpened([nextTab]);
    },
    [tab]
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
      const fromTab = fromTabs.current.pop() ?? tab;
      setScopes((current) => current.slice(0, -1));
      setTab(fromTab);
      setOpened([fromTab]);
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
    // One drill-down at a time: a double-click used to issue two lookups and
    // push two identical levels, so unwinding one step took two Escapes.
    if (hash === null || pendingBlameBefore.current) return;
    pendingBlameBefore.current = true;
    const short = hunk.shortHash ?? hash.slice(0, 7);
    void dispatch("commit:lookup", { worktreeId, hash }).then((result) => {
      pendingBlameBefore.current = false;
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
          via: `before ${short}`,
          // Land near where the reader was: the hunk's line numbering in the
          // commit that wrote it, which is the closest thing the parent has.
          line: hunk.originalStartLine
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
                    onViewFile={(entry) =>
                      pushScope(
                        {
                          path: entry.path,
                          context: { kind: "commit", hash: entry.hash },
                          via: `at ${entry.shortHash}`
                        },
                        "contents"
                      )
                    }
                  />
                ) : value === "blame" ? (
                  <BlameView
                    worktreeId={worktreeId}
                    path={scope.path}
                    context={scope.context}
                    {...(scope.line === undefined
                      ? {}
                      : { initialLine: scope.line })}
                    onOpenCommitFile={openCommitFile}
                    onShowCommit={showCommit}
                    onBlameBefore={blameBefore}
                  />
                ) : (
                  <ContentsView
                    worktreeId={worktreeId}
                    path={scope.path}
                    context={scope.context}
                  />
                )}
              </div>
            )
        )}
      </div>
    </section>
  );
}
