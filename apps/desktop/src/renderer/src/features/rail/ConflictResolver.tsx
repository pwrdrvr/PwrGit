import { useEffect, useState } from "react";
import type {
  ConflictInspection,
  ConflictOperation,
  ConflictStagePreview,
  ConflictState,
  ConflictedPath,
  ConflictWorkingTreePreview
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { confirmDialog } from "../shell/dialogs";

type PreviewSide = "workingTree" | "base" | "ours" | "theirs";

const KIND_COPY: Record<ConflictedPath["kind"], string> = {
  both_modified: "Both sides changed this path from the common base.",
  both_added: "Both sides added this path; there is no base version.",
  delete_or_rename_by_ours:
    "Missing from ours, but present in base and theirs. This may be a delete/modify or rename-related conflict.",
  delete_or_rename_by_theirs:
    "Missing from theirs, but present in base and ours. This may be a modify/delete or rename-related conflict.",
  added_by_ours: "Only ours has this added path.",
  added_by_theirs: "Only theirs has this added path.",
  complex:
    "Git exposed an unusual combination of index stages. Review each available version explicitly."
};

function operationNoun(operation: ConflictOperation): string {
  return operation.kind === "cherry-pick" ? "cherry-pick" : operation.kind;
}

function sideLabel(
  side: "ours" | "theirs",
  operation: ConflictOperation | null
): string {
  if (operation?.kind === "rebase") {
    return side === "ours"
      ? "Ours · rebased base"
      : "Theirs · replayed commit";
  }
  if (side === "ours") return "Ours · current branch";
  if (operation?.kind === "cherry-pick") return "Theirs · picked commit";
  if (operation?.kind === "revert") return "Theirs · reverted result";
  if (operation?.kind === "merge") return "Theirs · merged branch";
  return "Theirs · index stage 3";
}

function bytesLabel(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function PreviewContent({
  preview,
  draft,
  onDraft
}: {
  preview: ConflictStagePreview | ConflictWorkingTreePreview | null;
  draft: string;
  onDraft: ((text: string) => void) | null;
}) {
  if (preview === null) {
    return <div className="conflict-preview__empty">This stage is missing.</div>;
  }
  const { content } = preview;
  if (content.kind === "binary") {
    return (
      <div className="conflict-preview__empty">
        Binary data · {bytesLabel(preview.size)}. PwrGit will not decode or edit
        it.
      </div>
    );
  }
  if (content.kind === "too-large") {
    return (
      <div className="conflict-preview__empty">
        {bytesLabel(preview.size)} exceeds the {bytesLabel(content.limit)} inline
        preview limit. Open the working file externally to inspect it.
      </div>
    );
  }
  if (content.kind === "unavailable") {
    return <div className="conflict-preview__empty">{content.reason}</div>;
  }
  return onDraft === null ? (
    <pre className="conflict-preview__text selectable">{content.text}</pre>
  ) : (
    <textarea
      className="conflict-editor"
      aria-label="Working file contents"
      value={draft}
      onChange={(event) => onDraft(event.target.value)}
      spellCheck={false}
    />
  );
}

export function ConflictResolver({
  worktreeId,
  state,
  onRefresh
}: {
  worktreeId: string;
  state: ConflictState;
  onRefresh: () => Promise<void>;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(
    state.conflicts[0]?.path ?? null
  );
  const [inspection, setInspection] = useState<ConflictInspection | null>(null);
  const [previewSide, setPreviewSide] = useState<PreviewSide>("workingTree");
  const [draft, setDraft] = useState("");
  const [savedDraft, setSavedDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [inspectionVersion, setInspectionVersion] = useState(0);

  const selected =
    state.conflicts.find((conflict) => conflict.path === selectedPath) ?? null;

  useEffect(() => {
    if (
      selectedPath !== null &&
      state.conflicts.some((conflict) => conflict.path === selectedPath)
    ) {
      return;
    }
    setSelectedPath(state.conflicts[0]?.path ?? null);
  }, [selectedPath, state.conflicts]);

  useEffect(() => {
    setInspection(null);
    setPreviewSide("workingTree");
    if (selectedPath === null) return;
    let active = true;
    void dispatch("conflict:inspect", { worktreeId, path: selectedPath }).then(
      (result) => {
        if (!active) return;
        if (!result.ok) {
          showErrorToast({
            title: "Conflict inspection failed",
            message: result.error.message,
            detail: selectedPath
          });
          return;
        }
        setInspection(result.value);
        const text =
          result.value.workingTree?.content.kind === "text"
            ? result.value.workingTree.content.text
            : "";
        setDraft(text);
        setSavedDraft(text);
      }
    );
    return () => {
      active = false;
    };
  }, [inspectionVersion, selectedPath, worktreeId]);

  const refreshInspection = (): void =>
    setInspectionVersion((version) => version + 1);

  const runAndRefresh = async (
    label: string,
    command: () => ReturnType<typeof dispatch>
  ): Promise<boolean> => {
    setBusy(label);
    const result = await command();
    setBusy(null);
    if (!result.ok) {
      showErrorToast({
        title: `${label} failed`,
        message: result.error.message,
        ...(selectedPath === null ? {} : { detail: selectedPath })
      });
      await onRefresh();
      return false;
    }
    await onRefresh();
    return true;
  };

  const accept = async (side: "ours" | "theirs"): Promise<void> => {
    if (selected === null) return;
    const stage = selected[side];
    const deletes = stage === null;
    const yes = await confirmDialog({
      title: `Accept ${side} for this path?`,
      message: deletes
        ? `${sideLabel(side, state.operation)} has no ${selected.path}. Accepting it will delete and stage this path. Other conflicted paths and unrelated changes are untouched.`
        : `Replace ${selected.path} with ${sideLabel(side, state.operation).toLowerCase()} and stage only this path? Other conflicted paths and unrelated changes are untouched.`,
      confirmLabel: deletes ? "Accept deletion" : `Accept ${side}`,
      danger: deletes
    });
    if (!yes) return;
    await runAndRefresh(`Accept ${side}`, () =>
      dispatch("conflict:accept", {
        worktreeId,
        path: selected.path,
        side,
        expectedOid: stage?.oid ?? null
      })
    );
  };

  const stageCurrent = async (): Promise<void> => {
    if (selected === null) return;
    const yes = await confirmDialog({
      title: "Stage this resolution?",
      message: `Mark ${selected.path} resolved by staging its current working-copy state? PwrGit does not guess whether conflict markers or every intended edit have been removed.`,
      confirmLabel: "Stage resolution"
    });
    if (!yes) return;
    await runAndRefresh("Stage resolution", () =>
      dispatch("conflict:stage", { worktreeId, path: selected.path })
    );
  };

  const saveDraft = async (): Promise<void> => {
    if (selected === null || inspection?.workingTree == null) return;
    const expectedContentHash = inspection.workingTree.contentHash;
    const saved = await runAndRefresh("Save working file", () =>
      dispatch("conflict:writeWorkingFile", {
        worktreeId,
        path: selected.path,
        text: draft,
        expectedContentHash
      })
    );
    if (saved) {
      setSavedDraft(draft);
      showInfoToast({
        title: "Working file saved",
        message: "Review it, then stage the path when the resolution is complete."
      });
      refreshInspection();
    }
  };

  const openExternal = async (): Promise<void> => {
    if (selected === null) return;
    await runAndRefresh("Open externally", () =>
      dispatch("conflict:openExternal", {
        worktreeId,
        path: selected.path
      })
    );
  };

  const refreshAll = async (): Promise<void> => {
    await onRefresh();
    refreshInspection();
  };

  const continueOperation = async (): Promise<void> => {
    const operation = state.operation;
    if (operation === null || state.conflicts.length > 0) return;
    const noun = operationNoun(operation);
    const yes = await confirmDialog({
      title: `Continue ${noun}?`,
      message: `PwrGit will run git ${noun} --continue for this exact in-progress operation. Git hooks may run, and Git may stop again on another conflict or validation failure.`,
      confirmLabel: `Continue ${noun}`
    });
    if (!yes) return;
    await runAndRefresh(`Continue ${operation.label.toLowerCase()}`, () =>
      dispatch("conflict:continue", {
        worktreeId,
        operation: operation.kind
      })
    );
  };

  const abortOperation = async (): Promise<void> => {
    const operation = state.operation;
    if (operation === null) return;
    const noun = operationNoun(operation);
    const yes = await confirmDialog({
      title: `Abort ${noun}?`,
      message: `PwrGit will run git ${noun} --abort for this exact in-progress operation. Git will attempt to restore its pre-${noun} state; unrelated changes are not intentionally discarded, and Git may refuse if it cannot restore safely.`,
      confirmLabel: `Abort ${noun}`,
      danger: true
    });
    if (!yes) return;
    await runAndRefresh(`Abort ${operation.label.toLowerCase()}`, () =>
      dispatch("conflict:abort", {
        worktreeId,
        operation: operation.kind
      })
    );
  };

  const preview = inspection?.[previewSide] ?? null;
  const editableWorking =
    previewSide === "workingTree" &&
    inspection?.workingTree?.editable === true &&
    inspection.workingTree.content.kind === "text";

  return (
    <div className="conflict-pane">
      <div className="conflict-head">
        <div>
          <div className="conflict-head__eyebrow">
            {state.operation?.label ?? "Unmerged index"}
            {state.operation?.progress !== undefined &&
              ` · step ${state.operation.progress.current} of ${state.operation.progress.total}`}
          </div>
          <div className="conflict-head__title">
            {state.conflicts.length === 0
              ? "Ready to continue"
              : `${state.conflicts.length} unresolved path${state.conflicts.length === 1 ? "" : "s"}`}
          </div>
        </div>
        <button
          className="conflict-refresh"
          onClick={() => void refreshAll()}
          disabled={busy !== null}
        >
          Refresh
        </button>
      </div>

      {state.operation === null && state.conflicts.length > 0 && (
        <div className="conflict-note" role="note">
          Git has unmerged index stages but no merge, rebase, cherry-pick, or
          revert marker. This can follow a conflicted stash apply. Resolve and
          stage each path here; continue and abort are intentionally unavailable.
        </div>
      )}

      {state.conflicts.length > 0 && (
        <>
          <div className="conflict-paths" aria-label="Conflicted paths">
            {state.conflicts.map((conflict) => (
              <button
                key={conflict.path}
                className={`conflict-path${conflict.path === selectedPath ? " is-active" : ""}`}
                onClick={() => setSelectedPath(conflict.path)}
                title={conflict.path}
              >
                <span className="conflict-path__mark">U</span>
                <span className="conflict-path__name">{conflict.path}</span>
              </button>
            ))}
          </div>

          {selected !== null && (
            <div className="conflict-inspector">
              <div className="conflict-inspector__path selectable">
                {selected.path}
              </div>
              <div className="conflict-inspector__summary">
                {KIND_COPY[selected.kind]}
              </div>
              <div
                className="conflict-preview-tabs"
                role="tablist"
                aria-label="Conflict versions"
              >
                {(
                  [
                    ["workingTree", "Working"],
                    ["base", "Base"],
                    ["ours", "Ours"],
                    ["theirs", "Theirs"]
                  ] as const
                ).map(([side, label]) => (
                  <button
                    key={side}
                    role="tab"
                    aria-selected={previewSide === side}
                    className={previewSide === side ? "is-active" : ""}
                    onClick={() => setPreviewSide(side)}
                  >
                    {label}
                    {side !== "workingTree" && selected[side] === null
                      ? " · missing"
                      : ""}
                  </button>
                ))}
              </div>
              <div className="conflict-preview">
                {inspection === null ? (
                  <div className="conflict-preview__empty">Loading version…</div>
                ) : (
                  <PreviewContent
                    preview={preview}
                    draft={draft}
                    onDraft={editableWorking ? setDraft : null}
                  />
                )}
              </div>

              <div className="conflict-choice-row">
                <button
                  onClick={() => void accept("ours")}
                  disabled={busy !== null}
                >
                  Accept ours{selected.ours === null ? " (delete)" : ""}
                </button>
                <button
                  onClick={() => void accept("theirs")}
                  disabled={busy !== null}
                >
                  Accept theirs{selected.theirs === null ? " (delete)" : ""}
                </button>
              </div>
              <div className="conflict-file-row">
                {inspection?.workingTree != null && (
                  <button
                    onClick={() => void openExternal()}
                    disabled={busy !== null}
                  >
                    Open externally
                  </button>
                )}
                {editableWorking && (
                  <button
                    onClick={() => void saveDraft()}
                    disabled={busy !== null || draft === savedDraft}
                  >
                    Save working file
                  </button>
                )}
                <button
                  className="conflict-stage"
                  onClick={() => void stageCurrent()}
                  disabled={busy !== null}
                >
                  Stage current resolution
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {state.operation !== null && (
        <div className="conflict-operation-actions">
          <button
            className="conflict-abort"
            onClick={() => void abortOperation()}
            disabled={busy !== null}
          >
            Abort {operationNoun(state.operation)}…
          </button>
          <button
            className="conflict-continue"
            onClick={() => void continueOperation()}
            disabled={busy !== null || state.conflicts.length > 0}
          >
            {busy ?? `Continue ${operationNoun(state.operation)}…`}
          </button>
        </div>
      )}
    </div>
  );
}
