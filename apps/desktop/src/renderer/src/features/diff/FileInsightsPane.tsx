import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FileBlameHunk,
  FileBlamePage,
  FileHistoryEntry,
  FileInsightContext,
  GitHubCommitAuthorIdentityLookup
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { useRelativeClock } from "../../lib/useRelativeClock";
import { localWhen, shortWhen } from "../graph/graph-view";

export type FileInsightTab = "history" | "blame";

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
  onShowCommit
}: {
  worktreeId: string;
  path: string;
  context: FileInsightContext;
  onShowCommit: (hash: string, subject: string) => boolean;
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
        <article className="file-history__row" key={entry.hash}>
          <span
            className={`file-status file-status--${
              entry.status === "D"
                ? "danger"
                : entry.status === "A"
                  ? "ok"
                  : "warn"
            }`}
          >
            {entry.status}
          </span>
          <div className="file-history__content">
            <div className="file-history__title">
              <button
                className="file-insight__commit"
                onClick={() => onShowCommit(entry.hash, entry.subject)}
                aria-label={`Show commit ${entry.shortHash} in lineage`}
                title="Show this commit in the lineage"
              >
                {entry.shortHash}
              </button>
              <span className="file-history__subject">{entry.subject}</span>
              <span
                className="file-insight__time"
                title={localWhen(entry.committedAt)}
              >
                {shortWhen(entry.committedAt, now)}
              </span>
            </div>
            <div className="file-history__meta">
              <AuthorLabel
                hash={entry.hash}
                name={entry.authorName}
                email={entry.authorEmail}
                lookups={identities}
              />
              <span className="file-history__path" title={entry.path}>
                {entry.previousPath === undefined
                  ? entry.path
                  : `${entry.previousPath} → ${entry.path}`}
              </span>
            </div>
          </div>
        </article>
      ))}
      {error !== null && (
        <div className="file-insight__page-error" role="alert">
          More history couldn’t be loaded. {error}
        </div>
      )}
      {nextCursor !== null && (
        <button
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
        : `${(page.bytes / 1_000_000).toFixed(1)} MB`;
    return `Blame is limited to files up to 1 MB. ${size} is not loaded.`;
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
  onShowCommit
}: {
  worktreeId: string;
  path: string;
  context: FileInsightContext;
  onShowCommit: (hash: string, subject: string) => boolean;
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
      {hunks.map((hunk, hunkIndex) => (
        <article
          className={`file-blame__hunk${
            hunk.uncommitted ? " is-uncommitted" : ""
          }`}
          key={`${hunk.startLine}:${hunk.hash ?? "wip"}:${hunkIndex}`}
        >
          <div className="file-blame__meta">
            {hunk.hash === null ? (
              <span className="file-insight__commit is-uncommitted">WIP</span>
            ) : (
              <button
                className="file-insight__commit"
                onClick={() => onShowCommit(hunk.hash ?? "", hunk.subject)}
                aria-label={`Show commit ${hunk.shortHash ?? ""} in lineage`}
                title="Show this commit in the lineage"
              >
                {hunk.shortHash}
              </button>
            )}
            <AuthorLabel
              hash={hunk.hash}
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
            <span className="file-blame__subject">{hunk.subject}</span>
            <span className="file-blame__range">
              L{hunk.startLine}
              {hunk.endLine === hunk.startLine ? "" : `–${hunk.endLine}`}
            </span>
          </div>
          {hunk.sourcePath !== path && (
            <div className="file-blame__source">from {hunk.sourcePath}</div>
          )}
          <div className="file-blame__lines">
            {hunk.lines.map((line, offset) => (
              <div className="file-blame__line" key={hunk.startLine + offset}>
                <span className="file-blame__number">
                  {hunk.startLine + offset}
                </span>
                <code>{line || " "}</code>
              </div>
            ))}
          </div>
        </article>
      ))}
      {error !== null && (
        <div className="file-insight__page-error" role="alert">
          More blame lines couldn’t be loaded. {error}
        </div>
      )}
      {nextCursor !== null && (
        <button
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

export function FileInsightsPane({
  worktreeId,
  path,
  context,
  initialTab,
  onClose,
  onShowCommit
}: {
  worktreeId: string;
  path: string;
  context: FileInsightContext;
  initialTab: FileInsightTab;
  onClose: () => void;
  onShowCommit: (hash: string, subject: string) => boolean;
}) {
  const [tab, setTab] = useState<FileInsightTab>(initialTab);
  const [revealError, setRevealError] = useState<string | null>(null);
  const contextLabel =
    context.kind === "workingTree"
      ? "Working tree · through HEAD"
      : `Commit ${context.hash.slice(0, 7)}`;
  const showCommit = (hash: string, subject: string): boolean => {
    const revealed = onShowCommit(hash, subject);
    setRevealError(
      revealed
        ? null
        : "That commit is older than the loaded lineage window. File details remain open."
    );
    return revealed;
  };

  return (
    <section className="file-insight-pane" aria-label={`File ${tab}`}>
      <header className="file-insight-pane__head">
        <button className="file-insight-pane__back" onClick={onClose}>
          ‹ Diff
        </button>
        <span className="file-insight-pane__path" title={path}>
          {path}
        </span>
        <span className="file-insight-pane__context">{contextLabel}</span>
      </header>
      <div className="file-insight-tabs" role="tablist" aria-label="File details">
        <button
          role="tab"
          aria-selected={tab === "history"}
          className={tab === "history" ? "is-active" : ""}
          onClick={() => setTab("history")}
        >
          History
        </button>
        <button
          role="tab"
          aria-selected={tab === "blame"}
          className={tab === "blame" ? "is-active" : ""}
          onClick={() => setTab("blame")}
        >
          Blame
        </button>
      </div>
      <div className="file-insight-pane__body">
        {revealError !== null && (
          <div className="file-insight__notice" role="status">
            {revealError}
          </div>
        )}
        {tab === "history" ? (
          <HistoryView
            worktreeId={worktreeId}
            path={path}
            context={context}
            onShowCommit={showCommit}
          />
        ) : (
          <BlameView
            worktreeId={worktreeId}
            path={path}
            context={context}
            onShowCommit={showCommit}
          />
        )}
      </div>
    </section>
  );
}
