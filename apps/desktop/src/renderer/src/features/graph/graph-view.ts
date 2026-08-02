// Shared helper for the lineage graph. (Lane assignment lives in lane-layout.ts;
// the old single-branch "Only me" author filter was replaced by the multi-lane
// active-branch view.)

function elapsedSeconds(iso: string, now: number): number {
  const timestamp = new Date(iso).getTime();
  return Number.isNaN(timestamp)
    ? 0
    : Math.max(0, Math.floor((now - timestamp) / 1000));
}

/** Short "time since" label for a commit timestamp. */
export function shortWhen(iso: string, now: number = Date.now()): string {
  const secs = elapsedSeconds(iso, now);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    const remainingMins = mins % 60;
    return `${hrs}h${remainingMins > 0 ? ` ${remainingMins}m` : ""}`;
  }
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Human-readable age for a commit's detail card. */
export function longWhen(iso: string, now: number = Date.now()): string {
  const secs = elapsedSeconds(iso, now);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${shortWhen(iso, now)} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? "" : "s"} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** The exact commit timestamp in the viewer's local timezone. */
export function localWhen(iso: string): string {
  const timestamp = new Date(iso);
  if (Number.isNaN(timestamp.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  }).format(timestamp);
}
