import { useEffect, useRef, useState } from "react";
import type {
  PwrGitError,
  PullProgressPhase,
  RemoteDivergence,
  Result,
  SshRemoteRecovery,
  Worktree,
  WorktreeState
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { showErrorToast } from "../../lib/toast";
import { WorktreeMenu } from "../shell/WorktreeMenu";
import { PullDivergenceDialog } from "./PullDivergenceDialog";
import { ResetToRemoteDialog } from "./ResetToRemoteDialog";
import { SshRemoteRecoveryDialog } from "./SshRemoteRecoveryDialog";

type Chip = { text: string; tone: "muted" | "ok" | "warn" };

function baseChip(state: WorktreeState | null): Chip {
  if (state === null) return { text: "…", tone: "muted" };
  if (state.behind > 0) {
    const ahead = state.ahead > 0 ? ` · ↑${state.ahead}` : "";
    return { text: `↓${state.behind} behind${ahead}`, tone: "warn" };
  }
  if (state.ahead > 0) return { text: `↑${state.ahead} ahead`, tone: "ok" };
  if (!state.hasUpstream) return { text: "no upstream", tone: "muted" };
  return { text: "up to date", tone: "muted" };
}

/**
 * How far the repo's default branch has moved on without this branch — the
 * `main +4` chip. Not a sync state: pulling won't change it, which is why it
 * reads quieter than the sync chip and never takes the warn rung.
 *
 * The five fields are read from ONE source — mixing them can pair a fresh count
 * with a stale branch name, and the whole point of the chip is naming which
 * branch the count belongs to. That source is the live snapshot only when it is
 * *this* worktree's: `useWorktreeState` keeps the previous selection's snapshot
 * until the new `worktree:getState` resolves, and unlike a stale ↓behind count,
 * a stale drift chip states something false about the branch on screen ("main
 * has 4 commits not in <the branch you just navigated away from>").
 *
 * `null` when there's nothing to say: on the default branch itself, once the
 * work is contained in it, or with no shared history (count is 0 anyway).
 */
function defaultBranchDrift(
  state: WorktreeState | null,
  worktree: Worktree
): { text: string; title: string } | null {
  const s = state?.worktreeId === worktree.id ? state : worktree;
  if (s.isDefaultBranch || s.mergedIntoDefault || s.divergedFromDefault) {
    return null;
  }
  if (s.behindDefault <= 0) return null;
  const defaultBranch = s.defaultBranch || "default branch";
  return {
    text: `${defaultBranch} +${s.behindDefault}`,
    title: `${defaultBranch} has ${s.behindDefault} commits not in ${s.branch}; this is not commits available to pull`
  };
}

type Busy = "fetch" | "pull" | "push" | null;
type RecoveryBusy = "rebase" | "reset" | null;

export function pullPhaseLabel(phase: PullProgressPhase): string {
  switch (phase) {
    case "fetch":
      return "Fetching updates…";
    case "prepare":
      return "Preparing local changes…";
    case "fast_forward":
      return "Fast-forwarding and checking out files…";
    case "reapply":
      return "Reapplying local changes…";
    case "refresh":
      return "Finishing refresh…";
  }
}

export function WorktreeHeader({
  worktree,
  state
}: {
  worktree: Worktree;
  state: WorktreeState | null;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [pullPhase, setPullPhase] = useState<PullProgressPhase>("fetch");
  const [divergence, setDivergence] = useState<RemoteDivergence | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState<RecoveryBusy>(null);
  const [resetToRemoteOpen, setResetToRemoteOpen] = useState(false);
  const [sshRecovery, setSshRecovery] = useState<SshRemoteRecovery | null>(null);
  const [flash, setFlash] = useState<Chip | null>(null);
  const activeWorktreeId = useRef(worktree.id);
  const pullOperation = useRef(0);
  const recoveryInFlight = useRef<string | null>(null);
  const recoveryOperation = useRef(0);

  // Header instances stay mounted while selection changes, so an operation
  // started for one worktree must never surface a dialog or flash on another.
  useEffect(() => {
    activeWorktreeId.current = worktree.id;
    pullOperation.current += 1;
    recoveryOperation.current += 1;
    recoveryInFlight.current = null;
    setBusy(null);
    setPullPhase("fetch");
    setDivergence(null);
    setRecoveryBusy(null);
    setResetToRemoteOpen(false);
    setSshRecovery(null);
  }, [worktree.id]);

  useEffect(
    () =>
      subscribe("worktree:pullProgress", (event) => {
        if (event.worktreeId === activeWorktreeId.current) {
          setPullPhase(event.phase);
        }
      }),
    []
  );

  const showFlash = (chip: Chip, ms: number): void => {
    setFlash(chip);
    setTimeout(() => setFlash(null), ms);
  };

  // Failures surface twice on purpose: the inline chip flash (collapsed away
  // in narrow headers) AND an error toast, which is visible at any width and
  // links to the Logs window.
  const flashError = (kind: string, error: PwrGitError): void => {
    const firstLine = error.message.split("\n")[0];
    showFlash({ text: firstLine.slice(0, 64), tone: "warn" }, 3200);
    showErrorToast({
      title: `${kind} failed`,
      message: firstLine,
      detail: error.message
    });
  };

  const run = async (
    kind: Exclude<Busy, null>,
    fn: () => Promise<Result<unknown, PwrGitError>>,
    okChip: Chip,
    label: string
  ): Promise<void> => {
    setBusy(kind);
    const result = await fn();
    setBusy(null);
    if (result.ok) showFlash(okChip, 1600);
    else flashError(label, result.error);
  };

  const id = worktree.id;
  const onFetch = (): void => {
    void run(
      "fetch",
      () => dispatch("remote:fetch", { worktreeId: id }),
      { text: "fetched", tone: "muted" },
      "Fetch"
    );
  };
  const onPull = (): void => {
    const worktreeId = id;
    const operation = ++pullOperation.current;
    setPullPhase("fetch");
    setBusy("pull");
    void dispatch("remote:pull", { worktreeId }).then(async (result) => {
      if (!result.ok) {
        if (
          result.error.kind === "remote" &&
          result.error.code === "not_fast_forward"
        ) {
          const inspected = await dispatch("remote:inspectDivergence", {
            worktreeId
          });
          if (
            activeWorktreeId.current !== worktreeId ||
            pullOperation.current !== operation
          ) {
            return;
          }
          setBusy(null);
          if (inspected.ok) {
            setDivergence(inspected.value);
            return;
          }
        }
        if (
          activeWorktreeId.current !== worktreeId ||
          pullOperation.current !== operation
        ) {
          return;
        }
        setBusy(null);
        if (
          result.error.kind === "remote" &&
          result.error.code === "authentication_required"
        ) {
          const inspected = await dispatch("remote:inspectSshRecovery", {
            worktreeId
          });
          if (
            activeWorktreeId.current !== worktreeId ||
            pullOperation.current !== operation
          ) {
            return;
          }
          if (inspected.ok && inspected.value !== null) {
            setSshRecovery(inspected.value);
            return;
          }
        }
        flashError("Pull", result.error);
        return;
      }
      if (
        activeWorktreeId.current !== worktreeId ||
        pullOperation.current !== operation
      ) {
        return;
      }
      setBusy(null);
      const { stashed, reappliedWithConflicts } = result.value;
      if (reappliedWithConflicts) {
        showFlash(
          { text: "pulled · resolve stash conflicts", tone: "warn" },
          4000
        );
      } else if (stashed) {
        showFlash({ text: "pulled · changes reapplied", tone: "ok" }, 2400);
      } else {
        showFlash({ text: "fast-forwarded", tone: "ok" }, 1600);
      }
    });
  };

  const recover = async (action: Exclude<RecoveryBusy, null>): Promise<void> => {
    if (divergence === null || recoveryInFlight.current !== null) return;
    const worktreeId = id;
    const operation = ++recoveryOperation.current;
    recoveryInFlight.current = worktreeId;
    setRecoveryBusy(action);
    const result = await dispatch(
      action === "rebase" ? "remote:rebaseOntoUpstream" : "remote:resetToUpstream",
      {
        worktreeId,
        branch: divergence.branch,
        head: divergence.head,
        upstreamHead: divergence.upstreamHead
      }
    );
    if (
      recoveryOperation.current !== operation ||
      activeWorktreeId.current !== worktreeId
    ) {
      return;
    }
    recoveryInFlight.current = null;
    setRecoveryBusy(null);
    if (!result.ok) {
      setDivergence(null);
      flashError(action === "rebase" ? "Rebase" : "Reset", result.error);
      return;
    }
    setDivergence(null);
    showFlash(
      {
        text: action === "rebase" ? "rebased onto remote" : "reset to remote",
        tone: "ok"
      },
      2400
    );
  };
  const onPush = (): void => {
    void run(
      "push",
      () => dispatch("remote:push", { worktreeId: id }),
      { text: "pushed", tone: "ok" },
      "Push"
    );
  };

  const pullLabel = pullPhaseLabel(pullPhase);
  const chip =
    busy === "pull"
      ? { text: pullLabel, tone: "muted" as const }
      : (flash ?? baseChip(state));
  const dirty = state?.dirty ?? worktree.dirty;
  const behind = state?.behind ?? worktree.behind;
  const drift = defaultBranchDrift(state, worktree);

  return (
    <div className="wt-header">
      {/* Repo › branch › path moved up into the window strip (features/chrome/
          TitleBar.tsx). What's left is live worktree state and the git actions
          — hence __state, not __id — keeping this row's container-query
          degrade ladder. */}
      <div className="wt-header__state">
        {dirty > 0 && <span className="badge badge--warn">●{dirty}</span>}
        <span style={{ flex: 1 }} />
        {/* Left of the sync chip, which stays adjacent to the buttons it maps
            onto. Hidden mid-pull so the progress label keeps the width it
            ellipsizes into; on width it outlives the sync chip (see the
            container queries — ↓behind has the Pull accent, drift has nothing
            else). */}
        {drift !== null && busy !== "pull" && (
          <span className="sync-chip sync-chip--drift" title={drift.title}>
            {drift.text}
          </span>
        )}
        <span
          className={`sync-chip sync-chip--${chip.tone}${
            busy === "pull" ? " sync-chip--progress" : ""
          }`}
          role={busy === "pull" ? "status" : undefined}
        >
          {chip.text}
        </span>

        <div className="wt-actions">
          {/* While an op runs its button swaps the icon for a spinner — the
              labels and sync chip collapse away in narrow headers, so the
              icon itself must carry the busy state. aria-label keeps the
              accessible name when the label span is display:none. */}
          <button
            className="wt-btn"
            onClick={onFetch}
            disabled={busy !== null}
            aria-label="Fetch"
            aria-busy={busy === "fetch"}
            title="Fetch"
          >
            {busy === "fetch" ? (
              <span className="wt-btn__spinner" />
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
            )}
            <span className="wt-btn__label">
              {busy === "fetch" ? "Fetching…" : "Fetch"}
            </span>
          </button>

          <button
            className={`wt-btn wt-btn--pull${behind > 0 ? " is-behind" : ""}`}
            onClick={onPull}
            disabled={busy !== null}
            aria-label={busy === "pull" ? pullLabel : "Pull"}
            aria-busy={busy === "pull"}
            title={busy === "pull" ? pullLabel : "Pull · fetch + fast-forward"}
          >
            {busy === "pull" ? (
              <span className="wt-btn__spinner" />
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4v11" />
                <path d="m7 10 5 5 5-5" />
                <path d="M5 20h14" />
              </svg>
            )}
            <span className="wt-btn__label">
              {busy === "pull" ? pullLabel : "Pull"}
            </span>
          </button>

          <button
            className="wt-btn"
            onClick={onPush}
            disabled={busy !== null}
            aria-label="Push"
            aria-busy={busy === "push"}
            title="Push"
          >
            {busy === "push" ? (
              <span className="wt-btn__spinner" />
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20V9" />
                <path d="m7 14 5-5 5 5" />
                <path d="M5 4h14" />
              </svg>
            )}
            <span className="wt-btn__label">
              {busy === "push" ? "Pushing…" : "Push"}
            </span>
          </button>
        </div>
        <WorktreeMenu
          worktree={worktree}
          onResetToRemote={() => setResetToRemoteOpen(true)}
        />
      </div>
      {sshRecovery !== null && (
        <SshRemoteRecoveryDialog
          worktreeId={id}
          recovery={sshRecovery}
          onClose={() => setSshRecovery(null)}
          onChanged={() => {
            setSshRecovery(null);
            showFlash(
              { text: `${sshRecovery.remote} now uses SSH`, tone: "ok" },
              2400
            );
          }}
        />
      )}
      {divergence !== null && (
        <PullDivergenceDialog
          divergence={divergence}
          busy={recoveryBusy}
          onClose={() => setDivergence(null)}
          onRebase={() => void recover("rebase")}
          onReset={() => void recover("reset")}
        />
      )}
      {resetToRemoteOpen && (
        <ResetToRemoteDialog
          key={worktree.id}
          worktree={worktree}
          onClose={() => setResetToRemoteOpen(false)}
          onComplete={(mode, remoteBranch) =>
            showFlash(
              {
                text: `${mode} reset to ${remoteBranch}`,
                tone: mode === "hard" ? "warn" : "ok"
              },
              2600
            )
          }
        />
      )}
    </div>
  );
}
