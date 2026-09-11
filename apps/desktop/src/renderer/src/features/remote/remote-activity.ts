import type { RemoteActivity, RemoteActivityPhase } from "@pwrgit/shared";

/**
 * How long Git may go quiet during a *network* phase before the status says
 * so. `--progress` is forced on fetch and push, so silence there is evidence;
 * checkout and stash phases write nothing for perfectly ordinary reasons, and
 * warning about those would cry wolf on every pull.
 */
export const REMOTE_ACTIVITY_QUIET_MS = 20_000;

const NETWORK_PHASES: ReadonlySet<RemoteActivityPhase> = new Set([
  "fetch",
  "push"
]);

export function remoteActivityAction(activity: RemoteActivity): string {
  switch (activity.kind) {
    case "fetch":
      return "Fetch";
    case "pull":
      return "Pull";
    case "push":
      return "Push";
  }
}

/** "Pull · PwrAgnt · main" — the scope line, so a card is never ambiguous. */
export function remoteActivityTitle(activity: RemoteActivity): string {
  return [
    remoteActivityAction(activity),
    activity.repoName,
    activity.branch ?? undefined
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

/** What the status popover's Copy action puts on the clipboard. */
export function remoteActivityReport(
  activity: RemoteActivity,
  lines: string[],
  now: number
): string {
  return [
    remoteActivityTitle(activity),
    `${remoteActivityStatus(activity, now).label} (${formatElapsed(
      now - activity.startedAt
    )} elapsed)`,
    activity.command === null ? null : activity.command,
    "",
    ...(lines.length === 0 ? ["(Git has produced no output)"] : lines)
  ]
    .filter((part) => part !== null)
    .join("\n");
}
