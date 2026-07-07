import { useState } from "react";
import type {
  PwrGitError,
  Repo,
  Result,
  Worktree,
  WorktreeState
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { CopyTarget } from "../shell/CopyTarget";
import { WorktreeMenu } from "../shell/WorktreeMenu";
import { BranchSwitcher } from "./BranchSwitcher";

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

type Busy = "fetch" | "pull" | "push" | null;

export function WorktreeHeader({
  repo,
  worktree,
  state
}: {
  repo: Repo;
  worktree: Worktree;
  state: WorktreeState | null;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [flash, setFlash] = useState<Chip | null>(null);
  const [switching, setSwitching] = useState(false);

  const showFlash = (chip: Chip, ms: number): void => {
    setFlash(chip);
    setTimeout(() => setFlash(null), ms);
  };

  const run = async (
    kind: Exclude<Busy, null>,
    fn: () => Promise<Result<unknown, PwrGitError>>,
    okChip: Chip
  ): Promise<void> => {
    setBusy(kind);
    const result = await fn();
    setBusy(null);
    if (result.ok) showFlash(okChip, 1600);
    else {
      showFlash(
        { text: result.error.message.split("\n")[0].slice(0, 64), tone: "warn" },
        3200
      );
    }
  };

  const id = worktree.id;
  const onFetch = (): void => {
    void run(
      "fetch",
      () => dispatch("remote:fetch", { worktreeId: id }),
      { text: "fetched", tone: "muted" }
    );
  };
  const onPull = (): void => {
    void run("pull", () => dispatch("remote:pull", { worktreeId: id }), {
      text: "fast-forwarded",
      tone: "ok"
    });
  };
  const onPush = (): void => {
    void run("push", () => dispatch("remote:push", { worktreeId: id }), {
      text: "pushed",
      tone: "ok"
    });
  };

  const chip = flash ?? baseChip(state);
  const dirty = state?.dirty ?? worktree.dirty;
  const behind = state?.behind ?? worktree.behind;

  return (
    <div className="wt-header">
      <div className="wt-header__id">
        <span className="wt-header__repo">{repo.name}</span>
        <span className="wt-header__sep">›</span>
        <button
          className="wt-header__branch wt-header__branch--switch"
          title="Switch branch"
          onClick={() => setSwitching(true)}
        >
          <span className="wt-header__dot" />
          <span className="wt-header__branch-name">{worktree.branch}</span>
          <svg
            className="wt-header__caret"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {dirty > 0 && <span className="badge badge--warn">●{dirty}</span>}
        <span style={{ flex: 1 }} />
        <span className={`sync-chip sync-chip--${chip.tone}`}>{chip.text}</span>

        <div className="wt-actions">
          <button
            className="wt-btn"
            onClick={onFetch}
            disabled={busy !== null}
            title="Fetch"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
            <span className="wt-btn__label">
              {busy === "fetch" ? "Fetching…" : "Fetch"}
            </span>
          </button>

          <button
            className={`wt-btn wt-btn--pull${behind > 0 ? " is-behind" : ""}`}
            onClick={onPull}
            disabled={busy !== null}
            title="Pull · fetch + fast-forward"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4v11" />
              <path d="m7 10 5 5 5-5" />
              <path d="M5 20h14" />
            </svg>
            <span className="wt-btn__label">
              {busy === "pull" ? "Pulling…" : "Pull"}
            </span>
          </button>

          <button
            className="wt-btn"
            onClick={onPush}
            disabled={busy !== null}
            title="Push"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20V9" />
              <path d="m7 14 5-5 5 5" />
              <path d="M5 4h14" />
            </svg>
            <span className="wt-btn__label">
              {busy === "push" ? "Pushing…" : "Push"}
            </span>
          </button>
        </div>
      </div>
      <div className="wt-header__pathrow">
        <CopyTarget
          value={worktree.path}
          label="Copy worktree path"
          className="wt-header__path copyable"
          stopPropagation={false}
        >
          {worktree.path}
        </CopyTarget>
        <WorktreeMenu worktree={worktree} />
      </div>
      {switching && (
        <BranchSwitcher
          worktreeId={worktree.id}
          currentBranch={worktree.branch}
          onClose={() => setSwitching(false)}
        />
      )}
    </div>
  );
}
