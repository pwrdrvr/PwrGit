import { type ReactNode, useEffect, useState } from "react";
import type { ChangeSet, FileChange, Worktree } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { showErrorToast } from "../../lib/toast";
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

/** Accessible name for the one-letter status chip. */
const STATUS_LABEL: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Conflicted",
  "?": "Untracked"
};

/** A folder of new files this big starts collapsed — an untracked tree can be
 *  hundreds of files, and unfolding all of them buries the rest of the list. */
const FOLDER_AUTO_COLLAPSE = 10;

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
    </svg>
  );
}

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
  // `git clean` does not stop at the render cap, so neither can the warning:
  // count what is really there, not what fitted in the list.
  const shown = paths.length;
  const total =
    changes?.truncated === undefined
      ? shown
      : Math.max(shown, changes.truncated.staged, changes.truncated.unstaged);
  const yes = await confirmDialog({
    title: "Discard all changes?",
    message: `Discard all uncommitted changes across ${total} file${total === 1 ? "" : "s"}? This can't be undone.`,
    confirmLabel: "Discard all",
    danger: true
  });
  if (!yes) return;
  await dispatch("changes:discardAll", { worktreeId });
}

/**
 * One list entry: a single file, or a folder holding several of them. A folder
 * is the unit people actually think in — "stage the handoff scripts", "take
 * that whole directory back out" — so it gets one row that acts on every file
 * it lists, without hiding which files those are.
 */
export type ChangeEntry =
  | { kind: "file"; file: FileChange }
  | { kind: "folder"; dir: string; files: FileChange[] };

/** Group files by their parent folder, preserving git's order. */
export function groupChanges(files: FileChange[]): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  const folders = new Map<string, { dir: string; files: FileChange[] }>();

  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    if (slash <= 0) {
      entries.push({ kind: "file", file });
      continue;
    }
    const dir = file.path.slice(0, slash);
    const open = folders.get(dir);
    if (open === undefined) {
      const folder = { dir, files: [file] };
      folders.set(dir, folder);
      entries.push({ kind: "folder", ...folder });
    } else {
      open.files.push(file);
    }
  }

  // A "folder" holding one file is just that file with extra chrome.
  return entries.flatMap((entry) => {
    if (entry.kind === "file" || entry.files.length > 1) return [entry];
    const only = entry.files[0];
    return only === undefined ? [] : [{ kind: "file" as const, file: only }];
  });
}

const countFormat = new Intl.NumberFormat();

/**
 * Shown when the list was capped. Past a thousand changed files the useful
 * answer is a .gitignore rule rather than a longer list, so the notice leads
 * with the folder responsible instead of just apologising for the cut.
 */
function TruncationNotice({
  shown,
  total,
  largestUntrackedFolder
}: {
  /** How many this section actually rendered — read from the list itself, not
   *  from the cap, so the two can never drift apart. */
  shown: number;
  total: number;
  largestUntrackedFolder: { dir: string; count: number } | null;
}) {
  return (
    <div className="changes-truncated" role="status">
      <div className="changes-truncated__head">
        Showing {countFormat.format(shown)} of {countFormat.format(total)}{" "}
        files
      </div>
      <div className="changes-truncated__body">
        {largestUntrackedFolder === null ? (
          <>The rest are hidden to keep this list responsive.</>
        ) : (
          <>
            <code>{largestUntrackedFolder.dir}/</code> holds{" "}
            {countFormat.format(largestUntrackedFolder.count)} new files. Add it
            to <code>.gitignore</code> if it is build output — this list picks
            that up on its own.
          </>
        )}
      </div>
    </div>
  );
}

function FileRow({
  file,
  label,
  nested,
  onToggle,
  onOpen,
  onDiscard
}: {
  file: FileChange;
  /** Text to show — the basename inside a folder group, the full path outside. */
  label: string;
  nested: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className={`file-row is-clickable${file.staged ? " is-staged" : ""}${nested ? " file-row--nested" : ""}`}
      onClick={onOpen}
      title="View changes"
    >
      <span
        className={`file-status file-status--${STATUS_TONE[file.status] ?? "muted"}`}
        title={STATUS_LABEL[file.status] ?? "Changed"}
        aria-label={STATUS_LABEL[file.status] ?? "Changed"}
      >
        {file.status}
      </span>
      <span className="file-path" title={file.path}>
        {label}
      </span>
      <span className="file-row__actions">
        <button
          className="file-action file-action--discard"
          onClick={(e) => {
            e.stopPropagation();
            onDiscard();
          }}
          title="Discard changes"
          aria-label={`Discard changes to ${file.path}`}
        >
          <TrashIcon />
        </button>
        <button
          className={`file-action file-action--${file.staged ? "unstage" : "stage"}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          title={file.staged ? "Unstage" : "Stage"}
          aria-label={`${file.staged ? "Unstage" : "Stage"} ${file.path}`}
        >
          {file.staged ? <MinusIcon /> : <PlusIcon />}
        </button>
      </span>
    </div>
  );
}

function FolderRow({
  dir,
  count,
  open,
  staged,
  onToggleOpen,
  onToggle
}: {
  dir: string;
  count: number;
  open: boolean;
  /** The folder sits in the staged section, so its verb is "unstage". */
  staged: boolean;
  onToggleOpen: () => void;
  onToggle: () => void;
}) {
  const verb = staged ? "Unstage" : "Stage";
  return (
    <div className="folder-row" onClick={onToggleOpen}>
      <button
        className="folder-row__twisty"
        onClick={(e) => {
          e.stopPropagation();
          onToggleOpen();
        }}
        title={open ? "Hide files" : "Show files"}
        aria-label={`${open ? "Hide" : "Show"} the files in ${dir}`}
        aria-expanded={open}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d={open ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6"} />
        </svg>
      </button>
      <span className="folder-row__icon" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
      </span>
      <span className="folder-row__path" title={`${dir}/ — ${count} files`}>
        {dir}/
      </span>
      <span className="folder-row__count">{count}</span>
      <span className="file-row__actions">
        <button
          className={`file-action file-action--${staged ? "unstage" : "stage"}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          title={`${verb} all ${count} files in this folder`}
          aria-label={`${verb} all ${count} files in ${dir}`}
        >
          {staged ? <MinusIcon /> : <PlusIcon />}
        </button>
      </span>
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
  /** Explicit folder disclosure state; unset folders follow the size default. */
  const [folderOpen, setFolderOpen] = useState<Record<string, boolean>>({});
  const wtId = worktree?.id ?? null;

  useEffect(() => {
    setMessage("");
    setFolderOpen({});
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
    // Both events matter: `worktree:changed` covers work done outside PwrGit,
    // `changes:changed` covers our own index moves (which leave the coarse
    // worktree state identical, so the first event never fires for them).
    const offWorktree = subscribe("worktree:changed", (p) => {
      if (p.worktreeId === wtId) load();
    });
    const offChanges = subscribe("changes:changed", (p) => {
      if (p.worktreeId === wtId) load();
    });
    return () => {
      active = false;
      offWorktree();
      offChanges();
    };
  }, [wtId]);

  const run = (
    command: "changes:stage" | "changes:unstage",
    paths: string[]
  ): void => {
    if (wtId === null) return;
    void dispatch(command, { worktreeId: wtId, paths }).then((r) => {
      if (r.ok) return;
      showErrorToast({
        title: command === "changes:stage" ? "Stage failed" : "Unstage failed",
        message: r.error.message,
        detail: `${command} ${paths.join(", ")}`
      });
    });
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
  // The section headers count what git found, not what survived the cap — a
  // header reading "1,000" beside a notice reading "of 20,000" is just noise.
  const truncated = changes?.truncated;
  const stagedTotal = truncated?.staged ?? staged.length;
  const unstagedTotal = truncated?.unstaged ?? unstaged.length;
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

  const renderEntries = (
    files: FileChange[],
    keyPrefix: string,
    stagedSection: boolean
  ): ReactNode[] => {
    const command = stagedSection ? "changes:unstage" : "changes:stage";
    const fileRow = (
      file: FileChange,
      key: string,
      dir: string | null
    ): ReactNode => (
      <FileRow
        key={key}
        file={file}
        label={dir === null ? file.path : file.path.slice(dir.length + 1)}
        nested={dir !== null}
        onToggle={() => run(command, [file.path])}
        onOpen={() => onOpenDiff(file.path, stagedSection)}
        onDiscard={() => void discardOne(file)}
      />
    );

    return groupChanges(files).flatMap((entry, i) => {
      if (entry.kind === "file") {
        const key = `${keyPrefix}-${i}-${entry.file.path}`;
        return [fileRow(entry.file, key, null)];
      }
      // Disclosure state is keyed per section: the same folder can hold both
      // staged and unstaged files, and they fold independently.
      const foldKey = `${keyPrefix}:${entry.dir}`;
      const open =
        folderOpen[foldKey] ?? entry.files.length <= FOLDER_AUTO_COLLAPSE;
      return [
        <FolderRow
          key={`${keyPrefix}-${i}-${entry.dir}`}
          dir={entry.dir}
          count={entry.files.length}
          open={open}
          staged={stagedSection}
          onToggleOpen={() =>
            setFolderOpen((prev) => ({ ...prev, [foldKey]: !open }))
          }
          // Every listed file by name, not the directory: `git add -- dir`
          // would also sweep in nested folders this row never showed.
          onToggle={() =>
            run(
              command,
              entry.files.map((f) => f.path)
            )
          }
        />,
        ...(open
          ? entry.files.map((file, j) =>
              fileRow(file, `${keyPrefix}-${i}-${j}-${file.path}`, entry.dir)
            )
          : [])
      ];
    });
  };

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
            <div className="changes-section">
              <span className="changes-section__label">
                Staged · {countFormat.format(stagedTotal)}
              </span>
              <button
                className="changes-section__action"
                onClick={() => run("changes:unstage", ["."])}
                title="Unstage every staged file"
              >
                Unstage all
              </button>
            </div>
            {renderEntries(staged, "s", true)}
            {stagedTotal > staged.length && (
              <TruncationNotice
                shown={staged.length}
                total={stagedTotal}
                largestUntrackedFolder={null}
              />
            )}
          </>
        )}
        {unstaged.length > 0 && (
          <>
            <div className="changes-section">
              <span className="changes-section__label">
                Unstaged · {countFormat.format(unstagedTotal)}
              </span>
              <button
                className="changes-section__action"
                onClick={() => run("changes:stage", ["."])}
                title="Stage every changed and new file"
              >
                Stage all
              </button>
            </div>
            {renderEntries(unstaged, "u", false)}
            {unstagedTotal > unstaged.length && (
              <TruncationNotice
                shown={unstaged.length}
                total={unstagedTotal}
                largestUntrackedFolder={
                  truncated?.largestUntrackedFolder ?? null
                }
              />
            )}
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
            Commit{" "}
            {stagedTotal > 0
              ? `${countFormat.format(stagedTotal)} file${stagedTotal === 1 ? "" : "s"}`
              : ""}
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
