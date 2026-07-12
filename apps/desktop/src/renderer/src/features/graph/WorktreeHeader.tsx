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

/** Compact path label: the last two segments locate a checkout precisely
 *  ("GIPHY/search-compare", "mrb93172/PwrAgnt") without burning a line on
 *  the full path — that lives in the tooltip, and click copies it. */
function pathTail(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts.slice(-2).join("/");
}

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
    setBusy("pull");
    void dispatch("remote:pull", { worktreeId: id }).then((result) => {
      setBusy(null);
      if (!result.ok) {
        showFlash(
          { text: result.error.message.split("\n")[0].slice(0, 64), tone: "warn" },
          3200
        );
        return;
      }
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
        <span className="wt-header__repo" title={repo.name}>
          {repo.name}
        </span>
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
        <CopyTarget
          value={worktree.path}
          label="Copy worktree path"
          hint={`${worktree.path}\nClick to copy`}
          className="wt-header__pathchip copyable"
          stopPropagation={false}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </svg>
          {pathTail(worktree.path)}
        </CopyTarget>
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
