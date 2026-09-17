// What the in-flight half of the update toast says, as pure functions.
//
// Split out of the component for the reason `remote-activity.ts` is: the
// interesting part of a progress card is the wording and the arithmetic, and
// neither needs a DOM to be checked.

import { releaseNotesUrl, type AppUpdateStatus } from "@pwrgit/shared";

/** The statuses a user-initiated check passes through before it has an answer.
 *  While the status is one of these the toast shows a live card instead of a
 *  countdown — a bar draining toward a dismissal that has nothing to do with
 *  the work is the bug this file exists to fix. */
export type AppUpdateProgressStatus = Extract<
  AppUpdateStatus,
  { status: "checking" | "available" | "downloading" }
>;

export function isUpdateCheckInProgress(
  status: AppUpdateStatus
): status is AppUpdateProgressStatus {
  return (
    status.status === "checking" ||
    status.status === "available" ||
    status.status === "downloading"
  );
}

export type UpdateProgressCopy = {
  title: string;
  message: string;
  /** 0–100 for a determinate bar, `undefined` for the indeterminate sweep. */
  percent: number | undefined;
  /** Byte counts and rate, or `undefined` when the feed reports neither. */
  meter: string | undefined;
  /** A download is running, so there is something for Cancel to stop. */
  cancelable: boolean;
  /** The release page for the version being fetched, when it names one.
   *  `undefined` while `checking`, which has no version yet. */
  notesUrl: string | undefined;
};

export function updateProgressCopy(
  status: AppUpdateProgressStatus
): UpdateProgressCopy {
  if (status.status === "checking") {
    return {
      title: "Checking for updates",
      message: "Asking GitHub for the latest release…",
      percent: undefined,
      meter: undefined,
      cancelable: false,
      notesUrl: undefined
    };
  }
  if (status.status === "available") {
    return {
      title: "Update available",
      message: `Starting download of v${status.version}…`,
      percent: undefined,
      meter: undefined,
      cancelable: true,
      notesUrl: releaseNotesUrl(status.version)
    };
  }
  return {
    title: "Downloading update",
    message: `PwrGit v${status.version}${
      status.percent === undefined ? "" : ` — ${status.percent}%`
    }`,
    // A provider that sends no content length gives electron-updater nothing
    // to compute a percent from. Fall back to the sweep rather than pinning
    // the bar at 0% for the length of the download.
    percent: clampPercent(status.percent),
    meter: downloadMeter(status),
    cancelable: true,
    notesUrl: releaseNotesUrl(status.version)
  };
}

function clampPercent(percent: number | undefined): number | undefined {
  if (percent === undefined || !Number.isFinite(percent)) return undefined;
  return Math.min(100, Math.max(0, percent));
}

/** `24.1 MB of 118.0 MB · 3.2 MB/s`, dropping whichever half is unknown. */
export function downloadMeter(status: {
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}): string | undefined {
  const parts: string[] = [];
  if (isPositive(status.total) && isCount(status.transferred)) {
    parts.push(
      `${formatBytes(status.transferred)} of ${formatBytes(status.total)}`
    );
  } else if (isCount(status.transferred)) {
    parts.push(`${formatBytes(status.transferred)} transferred`);
  }
  if (isPositive(status.bytesPerSecond)) {
    parts.push(`${formatBytes(status.bytesPerSecond)}/s`);
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function isCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function isPositive(value: number | undefined): value is number {
  return isCount(value) && value > 0;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
