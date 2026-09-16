import type {
  RemoteActivity,
  RemoteActivityKind,
  RemoteActivityPhase
} from "@pwrgit/shared";

/**
 * How long Git may go quiet during a *network* phase before the status says
 * so. `--progress` is forced on fetch and push, so silence there is evidence;
 * checkout and stash phases write nothing for perfectly ordinary reasons, and
 * warning about those would cry wolf on every pull.
 */
export const REMOTE_ACTIVITY_QUIET_MS = 20_000;

/**
 * How long a *successful* card stays up before it takes itself away.
 *
 * It is the receipt for something the user just asked for and is looking
 * straight at, so it can be brief — 3s is tight under a diffstat, 5s starts to
 * feel like a card you have to wait out. Deliberately well under the error
 * toasts' 9s: those appear unasked and have to survive being ignored.
 *
 * A failure gets no countdown at all, and the pointer, a click and focus each
 * stop this one — which is what makes a duration this short acceptable under
 * WCAG SC 2.2.1 rather than a race.
 */
export const REMOTE_ACTIVITY_SETTLED_MS = 4_000;

/**
 * How long an operation must run before the card narrates it step by step.
 *
 * Below this it shows one stable line and then its receipt — two states, no
 * churn. A pull walks five phases and every transition publishes immediately,
 * so a 620ms pull otherwise lands five redraws in six tenths of a second: a
 * play-by-play of something that finished before the first frame could be
 * read. The steps are still *recorded* through the quiet period, so the
 * receipt says what happened either way; only the live narration waits.
 *
 * The card itself is NOT withheld. It opens on the click, which is what was
 * asked for and what makes the button feel answered — this gates what the card
 * says, not whether it is there.
 */
export const REMOTE_ACTIVITY_NARRATE_AFTER_MS = 600;

const NETWORK_PHASES: ReadonlySet<RemoteActivityPhase> = new Set([
  "fetch",
  "push"
]);

/**
 * A phase that represents *work*, and so earns a row of its own.
 *
 * `queued` is waiting on another operation's lock, `prepare` is a
 * `git status` (main emits it whether or not there is anything to stash), and
 * `refresh` is PwrGit's own bookkeeping after Git is done. None of the three
 * is an outcome, and a receipt listing "Checked for local changes ✓" between
 * two real steps is noise in the one place a user is reading carefully.
 *
 * They are dropped rather than shown-then-removed: a row that disappears is a
 * layout shift, which is the whole thing this list exists to avoid.
 */
export type RemoteActivityStepPhase = Exclude<
  RemoteActivityPhase,
  "queued" | "prepare" | "refresh"
>;

const STEP_LABELS: Record<
  RemoteActivityStepPhase,
  { running: string; done: string }
> = {
  fetch: { running: "Fetching updates", done: "Fetched" },
  push: { running: "Pushing commits", done: "Pushed" },
  fast_forward: { running: "Fast-forwarding", done: "Fast-forwarded" },
  reapply: {
    running: "Reapplying your changes",
    done: "Reapplied your changes"
  },
  recovery: {
    running: "Restoring the previous checkout",
    done: "Restored the previous checkout"
  }
};

export function isStepPhase(
  phase: RemoteActivityPhase
): phase is RemoteActivityStepPhase {
  return phase !== "queued" && phase !== "prepare" && phase !== "refresh";
}

/**
 * One row of the card's step list.
 *
 * A row changes exactly **once**: when its step completes, the label moves from
 * the present tense to the past, the marker turns, and the transfer readout is
 * dropped. After that it is fixed. It never moves position and is never
 * removed.
 *
 * That "once" is the whole of what makes the list readable, and the contrast
 * is with what it replaces: a single status line rewritten at every phase
 * boundary, over a Git-output tail rewriting its own last line at Git's
 * progress rate. One change per row, at the moment the row's own work ends, is
 * an event a reader can follow; a line that is a different sentence every time
 * you look at it is not.
 *
 * A step also reads `done` while the operation is in a phase that earns no row
 * of its own — during `prepare`, the fetch above it genuinely has finished.
 */
export type RemoteActivityStep = {
  phase: RemoteActivityStepPhase;
  label: string;
  /** The transfer readout, while this step is the one being worked. */
  detail: string | null;
  /** 0-100 while running and Git is reporting a meter; null otherwise. */
  percent: number | null;
  /**
   * `failed` is where an operation stopped, and it keeps the present-tense
   * label on purpose: "✕ Fetching updates" says *this is the step it was on*,
   * which is the one thing the row can add to the summary above it. Turning it
   * into "✓ Fetched" — which is what marking every step done on settle
   * produced — says the opposite of what happened.
   */
  state: "running" | "done" | "failed";
};

/**
 * The step list, from the phases an operation has been observed in.
 *
 * `seen` is ordered and deduplicated by the caller, which is the only thing
 * that knows the operation's history — a record carries the phase it is in
 * now, and nothing about the ones before it.
 */
export function activitySteps(
  seen: readonly RemoteActivityPhase[],
  current: RemoteActivityPhase | null,
  live: { detail: string | null; percent: number | null } = {
    detail: null,
    percent: null
  }
): RemoteActivityStep[] {
  return seen.filter(isStepPhase).map((phase) => {
    const running = phase === current;
    return {
      phase,
      label: STEP_LABELS[phase][running ? "running" : "done"],
      detail: running ? live.detail : null,
      percent: running ? live.percent : null,
      state: running ? ("running" as const) : ("done" as const)
    };
  });
}

export function remoteActivityAction(kind: RemoteActivityKind): string {
  switch (kind) {
    case "fetch":
      return "Fetch";
    case "pull":
      return "Pull";
    case "push":
      return "Push";
  }
}

/**
 * Who an operation belongs to — the three fields the scope line is built from.
 *
 * Widened past `RemoteActivity` because a *finished* operation has no live
 * record left to read them off, and the card outlives the record now.
 */
export type RemoteActivityScope = Pick<
  RemoteActivity,
  "kind" | "repoName" | "branch"
>;

/** "Pull · PwrAgnt · main" — the scope line, so a card is never ambiguous. */
export function remoteActivityTitle(scope: RemoteActivityScope): string {
  return [
    remoteActivityAction(scope.kind),
    scope.repoName,
    scope.branch ?? undefined
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
}

export function remoteActivityPhaseLabel(phase: RemoteActivityPhase): string {
  switch (phase) {
    case "queued":
      return "Waiting for another Git operation";
    case "fetch":
      return "Fetching updates";
    case "push":
      return "Pushing commits";
    case "prepare":
      return "Preparing local changes";
    case "fast_forward":
      return "Fast-forwarding and checking out files";
    case "reapply":
      return "Reapplying local changes";
    case "refresh":
      return "Finishing refresh";
    case "recovery":
      return "Restoring the previous checkout";
  }
}

/** `2m 41s` / `1h 04m`. Seconds matter here — these readouts are watched. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export type RemoteActivityTone = "muted" | "warn" | "ok" | "bad";

export type RemoteActivityStatus = {
  label: string;
  /** `warn` means "this is not progressing the way it should". */
  tone: "muted" | "warn";
};

/**
 * The one sentence that says what is happening and whether it is healthy.
 *
 * The distinction the old spinner could not draw: a five-minute fetch that is
 * *transferring* reads the same as one that has produced nothing at all. The
 * second is the bug report; it has to look different.
 */
export function remoteActivityStatus(
  activity: RemoteActivity,
  now: number
): RemoteActivityStatus {
  if (activity.canceling) return { label: "Stopping Git…", tone: "warn" };
  const phase = remoteActivityPhaseLabel(activity.phase);
  if (activity.phase === "queued") {
    return {
      label: `${phase} — ${formatElapsed(now - activity.startedAt)}`,
      tone: "muted"
    };
  }
  if (!NETWORK_PHASES.has(activity.phase)) return { label: phase, tone: "muted" };

  const quiet = now - activity.lastOutputAt;
  if (quiet < REMOTE_ACTIVITY_QUIET_MS) return { label: phase, tone: "muted" };
  return {
    label: activity.silent
      ? `Contacting the remote — no response for ${formatElapsed(quiet)}`
      : `${phase} — no Git output for ${formatElapsed(quiet)}`,
    tone: "warn"
  };
}

/** "Receiving objects 43% · 12.4 MiB · 3.1 MiB/s", or null with no meter. */
export function remoteActivityMeter(activity: RemoteActivity): string | null {
  const progress = activity.progress;
  if (progress === null) return null;
  return [
    `${progress.label} ${progress.percent}%`,
    progress.bytes,
    progress.rate
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
}

export type RemoteActivityOutcomeStatus = "ok" | "error" | "canceled";

/**
 * One *finished* remote operation, as the card reports it afterwards.
 *
 * Built in the renderer from the `Result` the dispatch already resolved with,
 * because that is the only place the rich reading exists — "fast-forwarded",
 * "changes reapplied", "resolve stash conflicts", "push denied" are all
 * derived from the response body, and none of them reach the live record.
 *
 * It carries its own scope and Git output rather than pointing at the record,
 * because by the time it exists the record is gone: `finish()` deletes it and
 * publishes in the same breath. Snapshot, not reference.
 */
export type RemoteActivityOutcome = {
  kind: RemoteActivityKind;
  status: RemoteActivityOutcomeStatus;
  repoName: string;
  branch: string | null;
  /** Epoch ms. The elapsed readout is the difference. */
  startedAt: number;
  endedAt: number;
  /** The one sentence: "Fast-forwarded · local changes reapplied". */
  summary: string;
  /** The last Git command line the live record carried, if it carried one. */
  command: string | null;
  /** Git's own last lines, copied off the record before it went away. */
  output: string[];
  /**
   * What the operation did, step by step — the receipt's substance.
   *
   * Accumulated while it ran, so it survives an operation whose narration was
   * never drawn: below `REMOTE_ACTIVITY_NARRATE_AFTER_MS` the live card shows
   * one line, and this is still the full list when it settles.
   */
  steps: RemoteActivityStep[];
};

/**
 * Everything the card draws, from a live record or a finished one.
 *
 * The card is one component with two sources, the same way it is one component
 * with two placements: the alternative is two near-identical cards drifting
 * apart, and the settled half is exactly the half a user reads most carefully.
 * Building the view is pure, so what each source produces is unit-testable
 * without rendering anything.
 */
export type RemoteActivityView = {
  /** The live operation Cancel and the log fetch address; null once over. */
  operationId: string | null;
  title: string;
  elapsed: string;
  statusLabel: string;
  statusTone: RemoteActivityTone;
  /** Live only — a finished operation has no meter left to move. */
  meter: string | null;
  percent: number | null;
  command: string | null;
  output: string[];
  /**
   * The step list. Empty means "nothing to narrate yet" — the card falls back
   * to the single status line, which is what a queued or just-started
   * operation has to say for itself.
   */
  steps: RemoteActivityStep[];
  /** Live only: Cancel is drawn, and inert once Git has been signalled. */
  canceling: boolean | null;
  /** How it ended, once it has. `null` while it is still running. */
  settled: RemoteActivityOutcomeStatus | null;
};

/**
 * The card for an operation that is still running.
 *
 * `steps` is passed in rather than read off the record: a record says which
 * phase the operation is in *now* and nothing about the ones before it, so the
 * history belongs to whoever has been watching. The toast passes none and gets
 * the status line, which is right for a card about a repository the user is
 * not looking at.
 */
export function liveActivityView(
  activity: RemoteActivity,
  now: number,
  steps: RemoteActivityStep[] = []
): RemoteActivityView {
  const status = remoteActivityStatus(activity, now);
  return {
    steps,
    operationId: activity.id,
    title: remoteActivityTitle(activity),
    elapsed: formatElapsed(now - activity.startedAt),
    statusLabel: status.label,
    statusTone: status.tone,
    meter: remoteActivityMeter(activity),
    percent: activity.progress?.percent ?? null,
    command: activity.command,
    output: activity.tail,
    canceling: activity.canceling,
    settled: null
  };
}

/**
 * The card for an operation that has ended — the receipt.
 *
 * A cancel reads `muted`, not `bad`: the user stopped it themselves a moment
 * ago and is looking at the button they pressed. Dressing their own decision
 * in the failure color is the same mistake `flashError` already avoids.
 */
export function settledActivityView(
  outcome: RemoteActivityOutcome
): RemoteActivityView {
  return {
    operationId: null,
    title: remoteActivityTitle(outcome),
    elapsed: formatElapsed(outcome.endedAt - outcome.startedAt),
    statusLabel: outcome.summary,
    statusTone:
      outcome.status === "error"
        ? "bad"
        : outcome.status === "ok"
          ? "ok"
          : "muted",
    meter: null,
    percent: null,
    command: outcome.command,
    output: outcome.output,
    // The receipt is what the running card became, so the rows that were on
    // screen a moment ago are still the rows on screen — with the step that
    // was in progress resolved one way or the other.
    steps: outcome.steps.map((step) => {
      const stopped = step.state === "running" && outcome.status !== "ok";
      return {
        ...step,
        label: stopped ? step.label : STEP_LABELS[step.phase].done,
        detail: null,
        percent: null,
        state: stopped ? ("failed" as const) : ("done" as const)
      };
    }),
    canceling: null,
    settled: outcome.status
  };
}

/** What the status card's Copy action puts on the clipboard. */
export function remoteActivityReport(
  view: RemoteActivityView,
  lines: string[]
): string {
  return [
    view.title,
    `${view.statusLabel} (${view.elapsed} elapsed)`,
    view.command,
    "",
    ...(lines.length === 0 ? ["(Git has produced no output)"] : lines)
  ]
    .filter((part) => part !== null)
    .join("\n");
}
