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

const NETWORK_PHASES: ReadonlySet<RemoteActivityPhase> = new Set([
  "fetch",
  "push"
]);

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
  /** Live only: Cancel is drawn, and inert once Git has been signalled. */
  canceling: boolean | null;
  /** How it ended, once it has. `null` while it is still running. */
  settled: RemoteActivityOutcomeStatus | null;
};

/** The card for an operation that is still running. */
export function liveActivityView(
  activity: RemoteActivity,
  now: number
): RemoteActivityView {
  const status = remoteActivityStatus(activity, now);
  return {
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
