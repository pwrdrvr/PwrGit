import { useEffect, useMemo, useState } from "react";
import type { LocalBranchSummary } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { branchNameProblem } from "../graph/branch-from-commit";

export function BranchRenameDialog({
  repoId,
  branch,
  existingBranches,
  onRenamed,
  onClose
}: {
  repoId: string;
  branch: LocalBranchSummary;
  existingBranches: readonly string[];
  onRenamed: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(branch.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const problem = useMemo(
    () =>
      branchNameProblem(
        name,
        existingBranches.filter((candidate) => candidate !== branch.name)
      ),
    [branch.name, existingBranches, name]
  );
  const unchanged = trimmed === branch.name;
  const nameError =
    problem === null || problem.kind === "empty"
      ? null
      : problem.kind === "taken"
        ? `A local branch named ${trimmed} already exists.`
        : problem.message;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = async (): Promise<void> => {
    if (busy || problem !== null || unchanged) return;
    setBusy(true);
    setError(null);
    const result = await dispatch("branch:rename", {
      repoId,
      branch: branch.name,
      newBranch: trimmed,
      expectedHead: branch.head
    });
    setBusy(false);
    if (!result.ok) {
      const message = result.error.message.split("\n")[0] ?? result.error.message;
      setError(message);
      showErrorToast({
        title: "Rename branch failed",
        message,
        detail: result.error.message
      });
      if (result.error.code === "stale_branch") {
        await onRenamed();
        onClose();
      }
      return;
    }
    showInfoToast({
      title: "Branch renamed",
      message: `${branch.name} is now ${trimmed}. Its remote branch, if any, was not renamed.`
    });
    await onRenamed();
    onClose();
  };

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="modal branch-rename"
        role="dialog"
        aria-label={`Rename branch ${branch.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title">Rename local branch</div>
        <div className="modal__hint">
          Rename {branch.name}. A configured upstream stays attached; no remote
          branch is renamed.
        </div>
        <input
          className="modal__input"
          autoFocus
          aria-label="New branch name"
          aria-invalid={nameError !== null}
          value={name}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
        {nameError !== null && <div className="modal__error">{nameError}</div>}
        {error !== null && <div className="modal__error">{error}</div>}
        <div className="modal__actions">
          <button className="modal__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal__create"
            disabled={busy || problem !== null || unchanged}
            onClick={() => void submit()}
          >
            {busy ? "Renaming…" : "Rename branch"}
          </button>
        </div>
      </div>
    </div>
  );
}
