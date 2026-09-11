import { useEffect, useRef, useState } from "react";
import type {
  PwrGitError,
  PullProgressPhase,
  RemoteDivergence,
  Repo,
  Result,
  SshRemoteRecovery,
  Worktree,
  WorktreeState
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { showErrorToast } from "../../lib/toast";
import { WorktreeMenu } from "../shell/WorktreeMenu";
import { GitLfsChip } from "./GitLfsChip";
import { PullDivergenceDialog } from "./PullDivergenceDialog";
import { openResetToRemote } from "./reset-to-remote";
import { SshRemoteRecoveryDialog } from "./SshRemoteRecoveryDialog";

type Chip = { text: string; tone: "muted" | "ok" | "warn" };

function baseChip(state: WorktreeState | null, worktree: Worktree): Chip {
  // A gone checkout outranks every sync reading: nothing below is true of a
  // directory that does not exist. Read it from this worktree's own row when
  // the live snapshot still belongs to the previous selection.
  const missing =
    state?.worktreeId === worktree.id ? state.missing : worktree.missing;
  if (missing === true) return { text: "directory missing", tone: "warn" };
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
  repo,
  worktree,
  state
}: {
  repo: Pick<Repo, "id" | "name" | "path">;
  worktree: Worktree;
  state: WorktreeState | null;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [pullPhase, setPullPhase] = useState<PullProgressPhase>("fetch");
  const [divergence, setDivergence] = useState<RemoteDivergence | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState<RecoveryBusy>(null);
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
      : (flash ?? baseChip(state, worktree));
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
        {/* Repo fact, not sync state, so it sits with the dirty badge on the
            left rather than among the chips the action buttons act on. */}
        <GitLfsChip
          repoId={repo.id}
          repoName={repo.name}
          repoPath={repo.path}
          worktreeId={worktree.id}
        />
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
          {/* The labels and sync chip collapse away in narrow headers, so the
              icon itself has to carry the busy state. aria-label keeps the
              accessible name when the label span is display:none.

              Two busy treatments, one rule: a circular arrow spins in place,
              and any other glyph swaps to the ring. Fetch's arrow IS a
              rotation, so rotating it is the literal reading and the button
              keeps its identity while it works; Pull's ↓ and Push's ↑ are not,
              and spinning them would read as broken. The accent tint that says
              "busy" is shared by all three and lives in app.css, keyed off
              aria-busy so it survives prefers-reduced-motion.

              `disabled` used to be set here while any of the three ran.
              Chromium blurs an element the moment it becomes disabled, so
              pressing Fetch from the keyboard threw focus to <body> for the
              length of the fetch (SC 2.4.3) — the same bug already fixed on
              .wt-refresh and .ref-fetch-all. aria-disabled says the same thing
              and keeps the button focusable; the guards below make them
              inert. */}
          <button
            className="wt-btn"
            onClick={() => {
              if (busy !== null) return;
              onFetch();
            }}
            aria-disabled={busy !== null}
            aria-label="Fetch"
            aria-busy={busy === "fetch"}
            /* The label span is display:none in the narrow header, so this is
               the only text left — it has to track busy, as Pull's does. */
            title={busy === "fetch" ? "Fetching…" : "Fetch"}
          >
            <RefreshGlyph />
            <span className="wt-btn__label">
              {busy === "fetch" ? "Fetching…" : "Fetch"}
            </span>
          </button>

          <button
            className={`wt-btn wt-btn--pull${behind > 0 ? " is-behind" : ""}`}
            onClick={() => {
              if (busy !== null) return;
              onPull();
            }}
            aria-disabled={busy !== null}
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
            onClick={() => {
              if (busy !== null) return;
              onPush();
            }}
            aria-disabled={busy !== null}
            aria-label="Push"
            aria-busy={busy === "push"}
            title={busy === "push" ? "Pushing…" : "Push"}
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
          className="kebab--toolbar"
          worktree={worktree}
          onResetToRemote={() =>
            openResetToRemote({
              worktree,
              onComplete: (mode, remoteBranch) =>
                showFlash(
                  {
                    text: `${mode} reset to ${remoteBranch}`,
                    tone: mode === "hard" ? "warn" : "ok"
                  },
                  2600
                )
            })
          }
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
          onResetElsewhere={() => {
            setDivergence(null);
            openResetToRemote({ worktree });
          }}
        />
      )}
    </div>
  );
}
