import type { ForgeKind } from "./types";

export const CONTRIBUTION_CAPABILITIES: Readonly<Record<ForgeKind, boolean>> = { github: true, gitlab: false, gitcafe: false };
/** Local, read-only metadata. No PR titles, bodies, credentials or review data. */
export type ContributionIdentity = { id: string; login: string; host: string };
export type ContributionRepo = {
  id: string; path: string; owner: string; ownerId: string;
  ownerKind: "organization" | "user";
  visibility: string; archived: boolean; fork: boolean;
  source?: "affiliated" | "authored_inventory";
};
export type ContributionEvent = { id: string; kind: "closed" | "reopened" | "merged"; at: string };
export type ContributionLifecycle = { createdAt: string; updatedAt: string; closedAt: string | null; state: "OPEN" | "CLOSED" | "MERGED"; events: ContributionEvent[]; complete: boolean; cursor: string | null; expected?: number; frozenState?: "OPEN" | "CLOSED" };
export type ContributionRecord = {
  id: string; repo: ContributionRepo; number: number; mergedAt: string | null;
  mergedBy: string | null; author: string | null;
  lifecycle?: ContributionLifecycle;
};
export type ContributionWindow = {
  startDate: string; endDate: string; timezone: string;
  /** Frozen UTC interval, start inclusive and end exclusive. */
  start: string; end: string;
  partialDay?: boolean;
};
export type ContributionSnapshot = {
  version: 1; profileId: string; identity: ContributionIdentity; window: ContributionWindow;
  status: "collecting" | "complete" | "partial" | "canceled";
  startedAt: string; refreshedAt: string | null;
  repos: ContributionRepo[]; records: ContributionRecord[];
  organizations: string[]; inventoryComplete: boolean;
  inventoryExpected: number | null; inventoryReceived: number;
  repoCursor: string | null; orgCursor: string | null; organizationsComplete: boolean;
  repoIndex: number; prCursor: string | null; pages: number;
  retryAt: string | null;
  authoredInventory: { cursor: string | null; expected: number | null; received: number; seen: string[]; complete: boolean };
  issues: { repoId: string | null; message: string }[];
};
export type ContributionMetric = "merged" | "authored" | "overlap" | "created";
export type ContributionOptions = {
  metric?: ContributionMetric; group?: "org" | "repo"; interval?: "day" | "week" | "month";
  topN?: number; ownerId?: string; repoId?: string;
};

// Reuse ICU formatters on the aggregation hot path; bound user-entered zones.
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
export function localContributionDate(instant: Date, timezone: string): string {
  let formatter = dateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    if (dateFormatters.size >= 16) dateFormatters.delete(dateFormatters.keys().next().value!);
    dateFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const value = (type: string) => parts.find(p => p.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
export function shiftContributionDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
export function defaultContributionDates(timezone: string, now = new Date()): { startDate: string; endDate: string } {
  const today = localContributionDate(now, timezone);
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(year, month - 7, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, lastDay));
  return { startDate: first.toISOString().slice(0, 10), endDate: shiftContributionDate(today, -1) };
}
/** Binary search the first instant of a civil date; DST days need not be 24h. */
function dayStart(date: string, timezone: string): string {
  let low = Date.parse(`${date}T00:00:00Z`) - 36 * 3_600_000;
  let high = low + 72 * 3_600_000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (localContributionDate(new Date(mid), timezone) < date) low = mid + 1;
    else high = mid;
  }
  return new Date(low).toISOString();
}
export function contributionWindow(startDate: string, endDate: string, timezone: string, now = new Date()): ContributionWindow {
  for (const date of [startDate, endDate]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("Choose valid calendar dates.");
  }
  const count = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1;
  if (count < 1 || count > 366) throw new Error("Choose a range of 1 to 366 calendar days.");
  const today = localContributionDate(now, timezone);
  if (endDate > today) throw new Error("The range cannot end in the future.");
  return { startDate, endDate, timezone, start: dayStart(startDate, timezone), end: endDate === today ? now.toISOString() : dayStart(shiftContributionDate(endDate, 1), timezone), ...(endDate === today ? { partialDay: true } : {}) };
}

export function contributionRows(records: ContributionRecord[], viewerId: string, window: ContributionWindow, options: ContributionOptions = {}): ContributionRecord[] {
  const seen = new Set<string>();
  return records.filter(row => {
    const key = JSON.stringify([row.repo.id, row.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    const date = options.metric === "created" ? row.lifecycle?.createdAt : row.mergedAt;
    const at = date ? Date.parse(date) : NaN;
    if (!(at >= Date.parse(window.start) && at < Date.parse(window.end))) return false;
    if (options.ownerId && row.repo.ownerId !== options.ownerId) return false;
    if (options.repoId && row.repo.id !== options.repoId) return false;
    switch (options.metric ?? "merged") {
      case "merged": return row.mergedBy === viewerId;
      case "authored": return row.author === viewerId;
      case "overlap": return row.mergedBy === viewerId && row.author === viewerId;
      case "created": return row.author === viewerId;
    }
  });
}

export function aggregateContributions(records: ContributionRecord[], viewerId: string, window: ContributionWindow, options: ContributionOptions = {}) {
  const rows = contributionRows(records, viewerId, window, options);
  const groupKey = (row: ContributionRecord) => options.group === "repo" ? row.repo.id : row.repo.ownerId;
  const groupLabel = (row: ContributionRecord) => options.group === "repo" ? row.repo.path : `${row.repo.ownerKind === "user" ? "Personal" : "Org"}: ${row.repo.owner}`;
  const totals = new Map<string, { key: string; label: string; total: number }>();
  for (const row of rows) {
    const key = groupKey(row);
    const value = totals.get(key) ?? { key, label: groupLabel(row), total: 0 };
    value.total++; totals.set(key, value);
  }
  const ranked = [...totals.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  const top = ranked.slice(0, Math.max(1, Math.min(12, options.topN ?? 6)));
  const topKeys = new Set(top.map(s => s.key));
  const other = ranked.slice(top.length).reduce((sum, s) => sum + s.total, 0);
  const series = other ? [...top, { key: "__other", label: "Other", total: other }] : top;
  const daily = new Map<string, { date: string; total: number; values: Record<string, number> }>();
  for (let day = window.startDate; day <= window.endDate; day = shiftContributionDate(day, 1)) daily.set(day, { date: day, total: 0, values: {} });
  for (const row of rows) {
    const date = options.metric === "created" ? row.lifecycle!.createdAt : row.mergedAt!;
    const day = daily.get(localContributionDate(new Date(date), window.timezone));
    if (!day) continue;
    const key = topKeys.has(groupKey(row)) ? groupKey(row) : "__other";
    day.total++; day.values[key] = (day.values[key] ?? 0) + 1;
  }
  const days = [...daily.values()];
  const buckets = new Map<string, typeof days[number]>();
  for (const day of days) {
    const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
    const date = options.interval === "month" ? day.date.slice(0, 7) : options.interval === "week" ? shiftContributionDate(day.date, -((weekday + 6) % 7)) : day.date;
    const bucket = buckets.get(date) ?? { date, total: 0, values: {} };
    bucket.total += day.total;
    for (const [key, value] of Object.entries(day.values)) bucket.values[key] = (bucket.values[key] ?? 0) + value;
    buckets.set(date, bucket);
  }
  const activeDays = days.filter(d => d.total > 0).length;
  const completeDays = window.partialDay ? days.slice(0, -1) : days;
  const completeTotal = completeDays.reduce((sum, day) => sum + day.total, 0);
  const busiest = days.reduce((best, day) => day.total > best.total ? day : best, days[0]!);
  return { total: rows.length, authored: contributionRows(records, viewerId, window, { ...options, metric: "authored" }).length,
    overlap: contributionRows(records, viewerId, window, { ...options, metric: "overlap" }).length,
    calendarDays: days.length, activeDays, perCalendarDay: rows.length / days.length,
    completeDays: completeDays.length, completeTotal, perCompleteDay: completeDays.length ? completeTotal / completeDays.length : 0,
    perActiveDay: activeDays ? rows.length / activeDays : 0, busiest, days, buckets: [...buckets.values()], series, totals: ranked };
}

/** Spreadsheet-safe cells, including user-controlled forge namespace strings. */
export function contributionCsv(headers: string[], rows: (string | number | null)[][]): string {
  const cell = (value: string | number | null) => {
    const text = String(value ?? "");
    return `"${(/^[=+@\-\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  };
  return [headers, ...rows].map(row => row.map(cell).join(",")).join("\r\n");
}

/** Author inflow/outflow and actual historical OPEN stock, never a merger/author subtraction. */
export function aggregateAuthorFlow(records: ContributionRecord[], viewerId: string, window: ContributionWindow, filters: Pick<ContributionOptions, "ownerId" | "repoId"> = {}) {
  const unique = new Map(records.map(row => [JSON.stringify([row.repo.id, row.id]), row]));
  const authored = [...unique.values()].filter(row => row.author === viewerId && (!filters.ownerId || filters.ownerId === row.repo.ownerId) && (!filters.repoId || filters.repoId === row.repo.id));
  const complete = authored.every(row => row.lifecycle?.complete);
  const start = Date.parse(window.start), end = Date.parse(window.end);
  const rows = authored.filter(row => row.lifecycle?.complete);
  type State = "OPEN" | "CLOSED" | "MERGED";
  const stateAt = (row: ContributionRecord, cutoff: number): State | null => {
    if (Date.parse(row.lifecycle!.createdAt) >= cutoff) return null;
    if (row.mergedAt && Date.parse(row.mergedAt) < cutoff) return "MERGED";
    if (row.lifecycle!.frozenState) return row.lifecycle!.frozenState;
    let state: State = "OPEN";
    const mergeEventTimes = new Set(row.lifecycle!.events.filter(event => event.kind === "merged").map(event => Date.parse(event.at)));
    for (const event of [...row.lifecycle!.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      if (Date.parse(event.at) >= cutoff) break;
      if (event.kind === "merged" || (event.kind === "closed" && (mergeEventTimes.has(Date.parse(event.at)) || (row.mergedAt !== null && Date.parse(event.at) === Date.parse(row.mergedAt))))) continue;
      state = event.kind === "closed" ? "CLOSED" : "OPEN";
    }
    return state;
  };
  const states = new Map<string, State>();
  const stateKey = (row: ContributionRecord) => JSON.stringify([row.repo.id, row.id]);
  let open = 0;
  const events: { row: ContributionRecord; kind: "created" | ContributionEvent["kind"]; at: string }[] = [];
  for (const row of rows) {
    const state = stateAt(row, start);
    if (state) { states.set(stateKey(row), state); if (state === "OPEN") open++; }
    events.push({ row, kind: "created", at: row.lifecycle!.createdAt });
    const mergeEventTimes = new Set(row.lifecycle!.events.filter(event => event.kind === "merged").map(event => Date.parse(event.at)));
    for (const event of row.lifecycle!.events) if (event.kind !== "merged" && !(event.kind === "closed" && (mergeEventTimes.has(Date.parse(event.at)) || (row.mergedAt !== null && Date.parse(event.at) === Date.parse(row.mergedAt))))) events.push({ row, kind: event.kind, at: event.at });
    if (row.mergedAt) events.push({ row, kind: "merged", at: row.mergedAt });
  }
  const baseline = open;
  const days = new Map<string, { date: string; created: number; merged: number; closedUnmerged: number; reopened: number; open: number; delta: number }>();
  for (let day = window.startDate; day <= window.endDate; day = shiftContributionDate(day, 1)) days.set(day, { date: day, created: 0, merged: 0, closedUnmerged: 0, reopened: 0, open: 0, delta: 0 });
  const ordered = events.filter(event => Date.parse(event.at) >= start && Date.parse(event.at) < end).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const event of ordered) {
    const day = days.get(localContributionDate(new Date(event.at), window.timezone))!;
    const id = stateKey(event.row), state = states.get(id);
    if (event.kind === "created") { day.created++; states.set(id, "OPEN"); open++; day.delta++; }
    if (event.kind === "merged" && state !== "MERGED") { day.merged++; if (state === "OPEN") { open--; day.delta--; } states.set(id, "MERGED"); }
    if (event.kind === "closed" && state === "OPEN" && event.row.mergedAt !== event.at) { day.closedUnmerged++; open--; day.delta--; states.set(id, "CLOSED"); }
    if (event.kind === "reopened" && state === "CLOSED") { day.reopened++; open++; day.delta++; states.set(id, "OPEN"); }
    day.open = open;
  }
  // Fill stock forward through zero-event days using the daily net transitions.
  open = baseline;
  for (const day of days.values()) { open += day.delta; day.open = open; }
  const cohort = rows.filter(row => Date.parse(row.lifecycle!.createdAt) >= start && Date.parse(row.lifecycle!.createdAt) < end);
  const cohortMerged = cohort.filter(row => row.mergedAt && Date.parse(row.mergedAt) < end).length;
  const cohortClosed = cohort.filter(row => stateAt(row, end) === "CLOSED").length;
  const unmergedAt = (cutoff: number) => rows.filter(row => { const state = stateAt(row, cutoff); return state === "OPEN" || state === "CLOSED"; }).length;
  const closedAt = (cutoff: number) => rows.filter(row => stateAt(row, cutoff) === "CLOSED").length;
  const values = [...days.values()].map(({ delta: _delta, ...day }) => day);
  return { complete, baseline, ending: open, days: values, created: values.reduce((sum, day) => sum + day.created, 0), merged: values.reduce((sum, day) => sum + day.merged, 0),
    closedUnmerged: values.reduce((sum, day) => sum + day.closedUnmerged, 0), reopened: values.reduce((sum, day) => sum + day.reopened, 0),
    cohortCreated: cohort.length, cohortMerged, cohortClosed, cohortNotMerged: cohort.length - cohortMerged,
    unmergedBaseline: unmergedAt(start), unmergedEnding: unmergedAt(end), closedBaseline: closedAt(start), closedEnding: closedAt(end),
    cohortMergePercentage: cohort.length ? cohortMerged / cohort.length * 100 : 0 };
}
