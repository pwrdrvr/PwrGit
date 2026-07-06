import { useEffect, useState } from "react";
import type { ChangeSet, FileChange, Worktree } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

const STATUS_TONE: Record<string, string> = {
  M: "warn",
  A: "ok",
  D: "danger",
  R: "warn",
  C: "warn",
  U: "danger",
  "?": "muted"
};

function FileRow({
  file,
  onToggle
}: {
  file: FileChange;
  onToggle: () => void;
}) {
  return (
    <div className={`file-row${file.staged ? " is-staged" : ""}`}>
      <span
        className={`file-status file-status--${STATUS_TONE[file.status] ?? "muted"}`}
      >
        {file.status}
      </span>
      <span className="file-path" title={file.path}>
        {file.path}
      </span>
      <button
        className="file-toggle"
        onClick={onToggle}
        title={file.staged ? "Unstage" : "Stage"}
      >
        {file.staged ? "−" : "+"}
      </button>
    </div>
  );
}

export function ChangesTab({
  worktree,
  activeEmail
}: {
  worktree: Worktree | null;
  activeEmail: string;
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

  const staged = changes?.staged ?? [];
  const unstaged = changes?.unstaged ?? [];
  const hasChanges = staged.length > 0 || unstaged.length > 0;
  const canCommit = message.trim() !== "" && staged.length > 0;

  if (!hasChanges) {
    return (
      <div className="changes-clean">
        <div className="changes-clean__icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6dba7e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
      <div className="changes-list">
        {staged.length > 0 && (
          <>
            <div className="changes-section">Staged · {staged.length}</div>
            {staged.map((f, i) => (
              <FileRow key={`s-${i}-${f.path}`} file={f} onToggle={() => unstage(f.path)} />
            ))}
          </>
        )}
        {unstaged.length > 0 && (
          <>
            <div className="changes-section">Changes · {unstaged.length}</div>
            {unstaged.map((f, i) => (
              <FileRow key={`u-${i}-${f.path}`} file={f} onToggle={() => stage(f.path)} />
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
