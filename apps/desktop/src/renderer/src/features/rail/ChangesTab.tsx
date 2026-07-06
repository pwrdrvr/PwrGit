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

function FileRow({ file }: { file: FileChange }) {
  return (
    <div className="file-row">
      <span
        className={`file-status file-status--${STATUS_TONE[file.status] ?? "muted"}`}
      >
        {file.status}
      </span>
      <span className="file-path" title={file.path}>
        {file.path}
      </span>
    </div>
  );
}

export function ChangesTab({ worktree }: { worktree: Worktree | null }) {
  const [changes, setChanges] = useState<ChangeSet | null>(null);

  useEffect(() => {
    if (worktree === null) {
      setChanges(null);
      return;
    }
    let active = true;
    const load = (): void => {
      void dispatch("changes:list", { worktreeId: worktree.id }).then((r) => {
        if (active && r.ok) setChanges(r.value);
      });
    };
    load();
    const off = subscribe("worktree:changed", (p) => {
      if (p.worktreeId === worktree.id) load();
    });
    return () => {
      active = false;
      off();
    };
  }, [worktree?.id]);

  const hasChanges =
    changes !== null &&
    (changes.staged.length > 0 || changes.unstaged.length > 0);

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
    <div className="changes-list">
      {changes.staged.length > 0 && (
        <>
          <div className="changes-section">Staged · {changes.staged.length}</div>
          {changes.staged.map((f, i) => (
            <FileRow key={`s-${i}-${f.path}`} file={f} />
          ))}
        </>
      )}
      {changes.unstaged.length > 0 && (
        <>
          <div className="changes-section">
            Changes · {changes.unstaged.length}
          </div>
          {changes.unstaged.map((f, i) => (
            <FileRow key={`u-${i}-${f.path}`} file={f} />
          ))}
        </>
      )}
    </div>
  );
}
