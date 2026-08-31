import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState
} from "react";
import type { ChangeSet, FileChange, Worktree } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { fileStatusChipProps } from "../../lib/fileStatus";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { ContextMenu } from "../shell/ContextMenu";
import { confirmDialog } from "../shell/dialogs";
import { SubmodulePanel } from "./SubmodulePanel";
import {
  canIgnore,
  changesRowMenuItems,
  ignorePathFor,
  targetIsStaged,
  targetPaths,
  type ChangesRowTarget
} from "./changes-row-menu";

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
  split,
  nested,
  onToggle,
  onOpen,
  onDiscard,
  onContextMenu,
  selected
}: {
  file: FileChange;
  /** Text to show — the basename inside a folder group, the full path outside. */
  label: string;
  /** The same path is listed in the other section too: this file is partly
   *  staged. Without a marker the two rows are indistinguishable from two
   *  unrelated files that happen to share a name. */
  split: boolean;
  nested: boolean;
  /** This row is what the main pane is currently showing. */
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onDiscard: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  return (
    <div
      className={`file-row is-clickable${file.staged ? " is-staged" : ""}${split ? " is-split" : ""}${nested ? " file-row--nested" : ""}${selected ? " is-selected" : ""}`}
      {...(selected ? { "aria-current": "true" as const } : {})}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      title={split ? "Partly staged — view these changes" : "View changes"}
    >
      <span {...fileStatusChipProps(file.status)}>{file.status}</span>
      <span className="file-path" title={file.path}>
        {label}
      </span>
      {split && (
        <span
          className="file-split"
          title={`Partly staged — this file also has ${file.staged ? "unstaged" : "staged"} changes`}
        >
          partial
        </span>
      )}
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
  onToggle,
  onDiscard,
  onContextMenu
}: {
  dir: string;
  count: number;
  open: boolean;
  /** The folder sits in the staged section, so its verb is "unstage". */
  staged: boolean;
  onToggleOpen: () => void;
  onToggle: () => void;
  onDiscard: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const verb = staged ? "Unstage" : "Stage";
  return (
    <div
      className="folder-row"
      onClick={onToggleOpen}
      onContextMenu={onContextMenu}
    >
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
          className="file-action file-action--discard"
          onClick={(e) => {
            e.stopPropagation();
            onDiscard();
          }}
          title={`Discard all ${count} files in this folder`}
          aria-label={`Discard all ${count} files in ${dir}`}
        >
          <TrashIcon />
        </button>
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
  onOpenDiff,
  onOpenFileInsight,
  activeFile
}: {
  worktree: Worktree | null;
  activeEmail: string;
  /** The file the main pane is showing, so this list can mark it. */
  activeFile: { path: string; staged: boolean | null } | null;
  onOpenDiff: (path: string, staged: boolean) => void;
  onOpenFileInsight: (
    path: string,
    tab: "history" | "blame",
    staged?: boolean
  ) => void;
}) {
  const [changes, setChanges] = useState<ChangeSet | null>(null);
  const [message, setMessage] = useState("");
  /** Explicit folder disclosure state; unset folders follow the size default. */
  const [folderOpen, setFolderOpen] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: ChangesRowTarget;
  } | null>(null);

  const openInsight = (
    target: ChangesRowTarget,
    tab: "history" | "blame"
  ): void => {
    if (target.kind !== "file") return;
    // The row's side of the index rides along, so a partially staged file
    // marks ONE row — the one the menu was opened on — not both.
    onOpenFileInsight(target.file.path, tab, target.file.staged);
  };
  const [hasSubmoduleConcern, setHasSubmoduleConcern] = useState(false);
  const wtId = worktree?.id ?? null;

  const receiveSubmoduleConcern = useCallback(
    (hasConcern: boolean) => setHasSubmoduleConcern(hasConcern),
    []
  );

  useEffect(() => {
    setMessage("");
    setFolderOpen({});
    setMenu(null);
    setHasSubmoduleConcern(false);
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

  /**
   * Which of the paths about to be staged are conflicted. "." means "stage
   * everything", and a directory row carries its subtree, so match by prefix
   * rather than equality.
   */
  const conflictedTargets = (paths: string[]): string[] =>
    (changes?.unstaged ?? [])
      .filter((file) => file.status === "U")
      .map((file) => file.path)
      .filter((path) =>
        paths.some(
          (target) =>
            target === "." || path === target || path.startsWith(`${target}/`)
        )
      );

  const run = (
    command: "changes:stage" | "changes:unstage",
    paths: string[]
  ): void => {
    if (wtId === null) return;
    void (async () => {
      // Staging a file that still has conflict markers is the classic way to
      // commit `<<<<<<<` into history. Warn, but do not refuse: a file can
      // legitimately contain marker-shaped lines.
      if (command === "changes:stage") {
        const targets = conflictedTargets(paths);
        if (targets.length > 0) {
          const scan = await dispatch("operation:markerScan", {
            worktreeId: wtId,
            paths: targets
          });
          if (scan.ok && scan.value.length > 0) {
            const shown = scan.value.slice(0, 5).join("\n");
            const rest =
              scan.value.length > 5
                ? `\n…and ${scan.value.length - 5} more`
                : "";
            const proceed = await confirmDialog({
              title: "Still has conflict markers",
              message: `${scan.value.length === 1 ? "A file you are staging still contains" : `${scan.value.length} files you are staging still contain`} conflict markers:\n\n${shown}${rest}\n\nStage anyway?`,
              confirmLabel: "Stage anyway",
              danger: true
            });
            if (!proceed) return;
          }
        }
      }
      const r = await dispatch(command, { worktreeId: wtId, paths });
      if (r.ok) return;
      showErrorToast({
        title: command === "changes:stage" ? "Stage failed" : "Unstage failed",
        message: r.error.message,
        detail: `${command} ${paths.join(", ")}`
      });
    })();
  };

  const commit = (amend: boolean): void => {
    if (wtId === null || message.trim() === "") return;
    void dispatch("changes:commit", { worktreeId: wtId, message, amend }).then(
      (r) => {
        if (r.ok) setMessage("");
      }
    );
  };

  /** Discard one row's worth of work — a file, or a whole folder group. */
  const discardTarget = async (target: ChangesRowTarget): Promise<void> => {
    if (wtId === null) return;
    const paths = targetPaths(target);
    if (paths.length === 0) return;
    const yes = await confirmDialog({
      title: "Discard changes?",
      message:
        target.kind === "file"
          ? `Discard your changes to ${target.file.path}? This can't be undone.`
          : `Discard your changes to all ${paths.length} file${paths.length === 1 ? "" : "s"} in ${target.dir}/? This can't be undone.`,
      confirmLabel: "Discard",
      danger: true
    });
    if (!yes) return;
    void dispatch("changes:discard", { worktreeId: wtId, paths }).then((r) => {
      if (r.ok) return;
      showErrorToast({
        title: "Discard failed",
        message: r.error.message,
        detail: paths.join(", ")
      });
    });
  };

  /** Write the row's `.gitignore` line. Only offered for untracked rows. */
  const ignoreTarget = (target: ChangesRowTarget): void => {
    if (wtId === null || !canIgnore(target)) return;
    const { path, directory } = ignorePathFor(target);
    void dispatch("changes:ignore", {
      worktreeId: wtId,
      entries: [{ path, directory }]
    }).then((r) => {
      if (!r.ok) {
        showErrorToast({
          title: "Could not update .gitignore",
          message: r.error.message,
          detail: path
        });
        return;
      }
      showInfoToast(
        r.value.added.length === 0
          ? {
              title: "Already ignored",
              message: `${path} was already covered by .gitignore.`
            }
          : {
              title: "Added to .gitignore",
              message: r.value.added.join(", ")
            }
      );
    });
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
      <div className="changes-pane">
        <div className="changes-list">
          {wtId !== null && (
            <SubmodulePanel
              worktreeId={wtId}
              onConcernChange={receiveSubmoduleConcern}
            />
          )}
          <div className="changes-clean">
            <div className="changes-clean__icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--status-ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m20 6-11 11-5-5" />
              </svg>
            </div>
            <div className="changes-clean__title">
              {hasSubmoduleConcern
                ? "Parent files are clean."
                : "Worktree is clean."}
            </div>
            <div className="changes-clean__sub">
              {hasSubmoduleConcern
                ? "Submodule attention is listed above."
                : "Nothing to commit."}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Paths git reports on both sides of the index. Partial staging makes this
  // ordinary, and until now it painted as the same filename twice with
  // nothing to connect the two rows.
  const unstagedPaths = new Set(unstaged.map((file) => file.path));
  const splitPaths = new Set(
    staged.map((file) => file.path).filter((path) => unstagedPaths.has(path))
  );
  // Which side of the index the active file means. Openers that know their
  // side say so; for those that don't (the palette, a commit-scoped view that
  // fell back), resolve against the sections — unstaged wins when the path is
  // in both, since a workingTree-context view shows working-tree content. One
  // row marks either way; `staged: null` used to match both.
  const effectiveActiveStaged: boolean | null =
    activeFile === null
      ? null
      : activeFile.staged !== null
        ? activeFile.staged
        : changes === null
          ? null
          : !changes.unstaged.some((file) => file.path === activeFile.path);

  const renderEntries = (
    files: FileChange[],
    keyPrefix: string,
    stagedSection: boolean
  ): ReactNode[] => {
    const command = stagedSection ? "changes:unstage" : "changes:stage";
    const openMenu = (
      event: ReactMouseEvent,
      target: ChangesRowTarget
    ): void => {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, target });
    };
    const fileRow = (
      file: FileChange,
      key: string,
      dir: string | null
    ): ReactNode => {
      const target: ChangesRowTarget = { kind: "file", file };
      return (
        <FileRow
          key={key}
          file={file}
          label={dir === null ? file.path : file.path.slice(dir.length + 1)}
          split={splitPaths.has(file.path)}
          nested={dir !== null}
          onToggle={() => run(command, [file.path])}
          onOpen={() => onOpenDiff(file.path, stagedSection)}
          onDiscard={() => void discardTarget(target)}
          onContextMenu={(event) => openMenu(event, target)}
          selected={
            activeFile !== null &&
            activeFile.path === file.path &&
            effectiveActiveStaged === file.staged
          }
        />
      );
    };

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
      const target: ChangesRowTarget = {
        kind: "folder",
        dir: entry.dir,
        files: entry.files
      };
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
          onDiscard={() => void discardTarget(target)}
          onContextMenu={(event) => openMenu(event, target)}
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
        {wtId !== null && (
          <SubmodulePanel
            worktreeId={wtId}
            onConcernChange={receiveSubmoduleConcern}
          />
        )}
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

      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label="File actions"
          onClose={() => setMenu(null)}
          items={changesRowMenuItems(menu.target, {
            onToggle: () =>
              run(
                targetIsStaged(menu.target)
                  ? "changes:unstage"
                  : "changes:stage",
                targetPaths(menu.target)
              ),
            onDiscard: () => void discardTarget(menu.target),
            onIgnore: () => ignoreTarget(menu.target),
            onCopyPath: () => void copyText(targetPaths(menu.target).join("\n")),
            onHistory: () => openInsight(menu.target, "history"),
            onBlame: () => openInsight(menu.target, "blame")
          })}
        />
      )}

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
