/** A worktree id to the epoch-millisecond time it was last selected in PwrGit. */
export type FocusVisits = Record<string, number>;

/** Keep the history bounded: it is a navigation signal, not an audit log. */
export const MAX_FOCUS_VISITS = 400;

export function parseFocusVisits(raw: string | null): FocusVisits {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const visits: FocusVisits = {};
    for (const [id, viewedAt] of Object.entries(parsed)) {
      if (
        id.length > 0 &&
        typeof viewedAt === "number" &&
        Number.isFinite(viewedAt) &&
        viewedAt >= 0
      ) {
        visits[id] = viewedAt;
      }
    }
    return visits;
  } catch {
    return {};
  }
}

/** Record one visit and discard the oldest entries once the bound is crossed. */
export function recordFocusVisit(
  visits: FocusVisits,
  worktreeId: string,
  viewedAt: number,
  limit: number = MAX_FOCUS_VISITS
): FocusVisits {
  if (
    worktreeId.length === 0 ||
    !Number.isFinite(viewedAt) ||
    viewedAt < 0
  ) {
    return visits;
  }
  const next = { ...visits, [worktreeId]: viewedAt };
  const entries = Object.entries(next);
  if (entries.length <= limit) return next;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, Math.max(0, limit)));
}
