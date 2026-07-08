// Shared helper for the lineage graph. (Lane assignment lives in lane-layout.ts;
// the old single-branch "Only me" author filter was replaced by the multi-lane
// active-branch view.)

/** Short "time since" label for a commit timestamp. */
export function shortWhen(iso: string, now: number = Date.now()): string {
  const secs = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
