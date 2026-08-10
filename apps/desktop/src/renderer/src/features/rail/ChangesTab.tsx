import { useEffect, useState } from "react";
import type { ChangeSet, FileChange, Worktree } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { confirmDialog } from "../shell/dialogs";

const STATUS_TONE: Record<string, string> = {
  M: "warn",
  A: "ok",
  D: "danger",
  R: "warn",
  C: "warn",
  U: "danger",
  "?": "muted"
};

export async function confirmAndDiscardAllChanges(
  worktreeId: string,
  changes: ChangeSet | null
): Promise<void> {
  const paths = [
    ...new Set(
      [...(changes?.staged ?? []), ...(changes?.unstaged ?? [])].map(
        (file) => file.path
      )
    )
  ];
  if (paths.length === 0) return;
  const yes = await confirmDialog({
    title: "Discard all changes?",
    message: `Discard all uncommitted changes across ${paths.length} file${paths.length === 1 ? "" : "s"}? This can't be undone.`,
    confirmLabel: "Discard all",
    danger: true
  });
  if (!yes) return;
  await dispatch("changes:discardAll", { worktreeId });
}

function FileRow({
  file,
  onToggle,
  onOpen,
  onDiscard
}: {
  file: FileChange;
  onToggle: () => void;
  onOpen: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className={`file-row is-clickable${file.staged ? " is-staged" : ""}`}
      onClick={onOpen}
      title="View changes"
    >
      <span
        className={`file-status file-status--${STATUS_TONE[file.status] ?? "muted"}`}
      >
        {file.status}
      </span>
      <span className="file-path" title={file.path}>
        {file.path}
      </span>
      <button
        className="file-discard"
        onClick={(e) => {
          e.stopPropagation();
          onDiscard();
        }}
        title="Discard changes"
        aria-label="Discard changes"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
        </svg>
      </button>
      <button
        className="file-toggle"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        title={file.staged ? "Unstage" : "Stage"}
      >
        {file.staged ? "−" : "+"}
      </button>
    </div>
  );
}

export function ChangesTab({
  worktree,
  activeEmail,
  onOpenDiff
}: {
  worktree: Worktree | null;
  activeEmail: string;
  onOpenDiff: (path: string, staged: boolean) => void;
}) {
  const [changes, setChanges] = useState<ChangeSet | null>(null);
  const [message, setMessage] = useState("");
  const wtId = worktree?.id ?? null;

  useEffect(() => {
    setMessage("");
    if (wtId === null) {
      setChanges(null);
      return;
    }
    let active = true;
    const load = (): void => {
      void dispatch("changes:list", { worktreeId: wtId }).then((r) => {
        if (active && r.ok) setChanges(r.value);
      });
    };
    load();
    const off = subscribe("worktree:changed", (p) => {
      if (p.worktreeId === wtId) load();
    });
    return () => {
      active = false;
      off();
    };
  }, [wtId]);

  const stage = (path: string): void => {
    if (wtId !== null) void dispatch("changes:stage", { worktreeId: wtId, path });
  };
  const unstage = (path: string): void => {
    if (wtId !== null)
      void dispatch("changes:unstage", { worktreeId: wtId, path });
  };
  const commit = (amend: boolean): void => {
    if (wtId === null || message.trim() === "") return;
    void dispatch("changes:commit", { worktreeId: wtId, message, amend }).then(
      (r) => {
        if (r.ok) setMessage("");
      }
    );
  };

  const discardOne = async (file: FileChange): Promise<void> => {
    if (wtId === null) return;
    const yes = await confirmDialog({
      title: "Discard changes?",
      message: `Discard your changes to ${file.path}? This can't be undone.`,
      confirmLabel: "Discard",
      danger: true
    });
    if (yes) void dispatch("changes:discard", { worktreeId: wtId, path: file.path });
  };

  const discardAll = async (): Promise<void> => {
    if (wtId === null) return;
    await confirmAndDiscardAllChanges(wtId, changes);
  };

  const staged = changes?.staged ?? [];
  const unstaged = changes?.unstaged ?? [];
  const hasChanges = staged.length > 0 || unstaged.length > 0;
  const canCommit = message.trim() !== "" && staged.length > 0;

  if (!hasChanges) {
    return (
      <div className="changes-clean">
        <div className="changes-clean__icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--status-ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m20 6-11 11-5-5" />
          </svg>
        </div>
        <div className="changes-clean__title">Worktree is clean.</div>
        <div className="changes-clean__sub">Nothing to commit.</div>
      </div>
    );
  }

  return (
    <div className="changes-pane">
      <div className="changes-wip" title="Uncommitted changes in the working tree">
        <span className="changes-wip__dot" />
        Work in progress · uncommitted
        <span style={{ flex: 1 }} />
        <button
          className="changes-wip__discard"
          onClick={() => void discardAll()}
          title="Discard every uncommitted change in this worktree"
        >
          Discard all
        </button>
      </div>
      <div className="changes-list">
        {staged.length > 0 && (
          <>
            <div className="changes-section">Staged · {staged.length}</div>
            {staged.map((f, i) => (
              <FileRow
                key={`s-${i}-${f.path}`}
                file={f}
                onToggle={() => unstage(f.path)}
                onOpen={() => onOpenDiff(f.path, true)}
                onDiscard={() => void discardOne(f)}
              />
            ))}
          </>
        )}
        {unstaged.length > 0 && (
          <>
            <div className="changes-section">Unstaged · {unstaged.length}</div>
            {unstaged.map((f, i) => (
              <FileRow
                key={`u-${i}-${f.path}`}
                file={f}
                onToggle={() => stage(f.path)}
                onOpen={() => onOpenDiff(f.path, false)}
                onDiscard={() => void discardOne(f)}
              />
            ))}
          </>
        )}
      </div>

      <div className="commit-box">
        <input
          className="commit-input"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Summary"
        />
        <div className="commit-actions">
          <button
            className="commit-btn"
            disabled={!canCommit}
            onClick={() => commit(false)}
          >
            Commit {staged.length > 0 ? `${staged.length} file${staged.length === 1 ? "" : "s"}` : ""}
          </button>
          <button
            className="amend-btn"
            disabled={message.trim() === ""}
            onClick={() => commit(true)}
          >
            Amend
          </button>
        </div>
        <div className="commit-as">as {activeEmail !== "" ? activeEmail : "—"}</div>
      </div>
    </div>
  );
}
