import { useCallback, useEffect, useState } from "react";
import type { OperationState, Repo, RepositoryStack, StackAction, StackApplied, StackConflict, StackPlanPreview } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";

type Stage =
  | { phase: "idle" }
  | { phase: "plan"; plan: StackPlanPreview }
  | { phase: "conflict"; conflict: StackConflict }
  | { phase: "done"; applied: StackApplied };

const IDLE: Stage = { phase: "idle" };

export function useStackOperation(
  repo: Repo | undefined,
  stackId: string | undefined,
  onStackChanged: (repoId: string, stack: RepositoryStack) => void,
  showRail: () => void,
) {
  const repoId = repo?.id;
  const profileId = repo?.profileId;
  const [stage, setStage] = useState<Stage>(IDLE);
  const [pending, setPending] = useState<"plan" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const conflictId = stage.phase === "conflict" ? stage.conflict.worktreeId : null;

  const loadConflict = useCallback(async () => {
    if (!repoId || !profileId || !stackId) return null;
    const result = await dispatch("stack:conflict", { repoId, profileId, stackId });
    return result.ok ? result.value : null;
  }, [repoId, profileId, stackId]);

  useEffect(() => {
    let live = true;
    setStage(previous => previous.phase === "done" && previous.applied.stack?.id === stackId ? previous : IDLE);
    setError(null);
    void loadConflict().then(conflict => {
      if (live && conflict) setStage({ phase: "conflict", conflict });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [loadConflict, stackId]);

  useEffect(() => {
    if (!conflictId) { setOperation(null); return; }
    let live = true;
    const refresh = () => {
      void dispatch("operation:state", { worktreeId: conflictId }).then(result => {
        if (live && result.ok) setOperation(result.value);
      });
      void loadConflict().then(conflict => {
        if (live && conflict) setStage({ phase: "conflict", conflict });
      });
    };
    refresh();
    const changes = subscribe("changes:changed", event => { if (event.worktreeId === conflictId) refresh(); });
    const worktree = subscribe("worktree:changed", event => { if (event.worktreeId === conflictId) refresh(); });
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      changes();
      worktree();
      window.removeEventListener("focus", refresh);
    };
  }, [conflictId, loadConflict]);

  const report = (applied: StackApplied) => {
    if (!repoId || !profileId) return;
    setStage({ phase: "done", applied });
    if (applied.stack) onStackChanged(repoId, applied.stack);
    const count = applied.plan.moves.length;
    const title = applied.plan.action.kind === "restack" ?
      `Restacked ${count} ${count === 1 ? "branch" : "branches"}` : "Stack updated";
    showInfoToast({
      title, message: applied.checkoutWarning ?? "Local changes applied",
      subject: { repoId },
      action: {
        label: "Undo", run: () => void dispatch("stack:undo", { repoId, profileId, operationId: applied.operationId })
          .then(result => {
            if (result.ok) {
              setStage(IDLE);
              showInfoToast({ title: "Stack operation undone", message: "Previous branch tips restored", subject: { repoId } });
            } else showErrorToast({ title: "Could not undo stack operation", message: result.error.message, subject: { repoId } });
          }),
      },
    });
  };

  const requested = async (action: StackAction) => {
    if (!repoId || !profileId || !stackId || pending) return;
    setPending("plan");
    setError(null);
    setStage(IDLE);
    showRail();
    try {
      const result = await dispatch("stack:plan", { repoId, profileId, stackId, action });
      if (result.ok) setStage({ phase: "plan", plan: result.value });
      else setError(result.error.message);
    } finally { setPending(null); }
  };

  const run = async (cleanPrefix: boolean, worktreeId: string | undefined) => {
    if (!repoId || !profileId || pending || stage.phase !== "plan") return;
    setPending("run");
    setError(null);
    try {
      const result = await dispatch("stack:apply", {
        repoId, profileId, planId: stage.plan.id, cleanPrefix, ...(worktreeId ? { worktreeId } : {}),
      });
      if (result.ok) report(result.value);
      else setError(result.error.message);
    } finally { setPending(null); }
  };

  const resolve = async () => {
    if (!repoId || !profileId || pending || stage.phase !== "plan") return;
    setPending("run");
    setError(null);
    try {
      const result = await dispatch("stack:resolve", { repoId, profileId, planId: stage.plan.id });
      if (result.ok) setStage({ phase: "conflict", conflict: result.value });
      else setError(result.error.message);
    } finally { setPending(null); }
  };

  const finish = async () => {
    if (!repoId || !profileId || pending || stage.phase !== "conflict") return;
    setPending("run");
    setError(null);
    try {
      const result = await dispatch("stack:finishConflict", { repoId, profileId, planId: stage.conflict.plan.id });
      if (!result.ok) setError(result.error.message);
      else if (result.value.applied) report(result.value.applied);
      else setStage(result.value.plan ? { phase: "plan", plan: result.value.plan } : IDLE);
    } finally { setPending(null); }
  };

  return { stage, pending, error, operation, requested, run, resolve, finish, loadConflict,
    cancel: () => { setStage(IDLE); setError(null); } };
}

export type StackOperationControls = ReturnType<typeof useStackOperation>;
