/**
 * Coarse "how long ago" for list rows: today / 3d / 2w / 5mo / 1y.
 *
 * Deliberately day-grained. Rows show it beside a name to answer "is this
 * still live?", and a minute-precise answer there is noise that changes on
 * every render. Surfaces that need finer resolution — how stale the fetch a
 * destructive action reads from is — format their own.
 */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
