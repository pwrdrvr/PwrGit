/**
 * What the sync button (Fetch ▾ / Pull ▾) and the bulk-sync run remember
 * between runs.
 * Design: `design/Fetch Toast and Scope - UX Review.dc.html`, turns 2 and 3.
 *
 * All four are per machine (`localStorage`), not per profile, and every
 * read falls back to the default on anything it does not recognise, so a
 * stale or hand-edited value never breaks the toolbar.
 */

/** Which repositories the sync button's face covers. */
export type FetchScope = "all" | "recent";

/** What the sync button's face does: fetch, or fetch and then fast-forward
 *  clean branches (Try pull). Timed runs always fetch, whatever this says. */
export type SyncVerb = "fetch" | "pull";

/** How a run shows itself when it starts. Unset means "never chosen": the
 *  dialog opens and minimises itself once, to teach where the toast lives. */
export type BulkSyncView = "dialog" | "toast";

/** Minutes between automatic fetches; 0 is off. */
export const FETCH_INTERVALS = [0, 1, 5, 15, 60] as const;
export type FetchInterval = (typeof FETCH_INTERVALS)[number];

export const FETCH_SCOPE_KEY = "pwrgit.fetchScope";
export const SYNC_VERB_KEY = "pwrgit.syncVerb";
export const FETCH_INTERVAL_KEY = "pwrgit.fetchIntervalMinutes";
export const BULK_SYNC_VIEW_KEY = "pwrgit.bulkSyncView";

/** How long a first-ever dialog stays before it minimises itself. */
export const FIRST_RUN_MINIMIZE_MS = 4_000;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or a full quota: the choice still holds for this session.
  }
}

export function readFetchScope(): FetchScope {
  return read(FETCH_SCOPE_KEY) === "recent" ? "recent" : "all";
}

export function writeFetchScope(scope: FetchScope): void {
  write(FETCH_SCOPE_KEY, scope);
}

export function readSyncVerb(): SyncVerb {
  return read(SYNC_VERB_KEY) === "pull" ? "pull" : "fetch";
}

export function writeSyncVerb(verb: SyncVerb): void {
  write(SYNC_VERB_KEY, verb);
}

export function readFetchInterval(): FetchInterval {
  const raw = Number(read(FETCH_INTERVAL_KEY));
  return (FETCH_INTERVALS as readonly number[]).includes(raw)
    ? (raw as FetchInterval)
    : 0;
}

export function writeFetchInterval(minutes: FetchInterval): void {
  write(FETCH_INTERVAL_KEY, String(minutes));
}

export function readBulkSyncView(): BulkSyncView | null {
  const raw = read(BULK_SYNC_VIEW_KEY);
  return raw === "dialog" || raw === "toast" ? raw : null;
}

export function writeBulkSyncView(view: BulkSyncView): void {
  write(BULK_SYNC_VIEW_KEY, view);
}

export function fetchIntervalLabel(minutes: FetchInterval): string {
  switch (minutes) {
    case 0:
      return "Off";
    case 1:
      return "Every minute";
    case 60:
      return "Every hour";
    default:
      return `Every ${minutes} minutes`;
  }
}

/** The interval as it reads inside a sentence: "every 5 minutes". */
export function fetchIntervalPhrase(minutes: FetchInterval): string | null {
  return minutes === 0 ? null : fetchIntervalLabel(minutes).toLowerCase();
}
