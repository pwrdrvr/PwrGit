/** Known deployments, not hostname-pattern guesses. Git and review endpoints
 * can differ. Other installations must be explicitly configured as Gerrit. */
export const GERRIT_SITES: Readonly<Record<string, { reviewUrl: string; browserUrl: string }>> = {
  "chromium.googlesource.com": {
    reviewUrl: "https://chromium-review.googlesource.com",
    browserUrl: "https://chromium.googlesource.com"
  },
  "codereview.qt-project.org": {
    reviewUrl: "https://codereview.qt-project.org",
    browserUrl: "https://codereview.qt-project.org"
  }
};

/** An explicit HTTPS Gerrit base, optionally mounted below a path. */
export function safeGerritReviewUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (!/^[a-z0-9.-]+$/i.test(url.hostname)) return null;
    return url.href.replace(/\/+$/, "");
  } catch { return null; }
}

export function gerritReviewUrl(host: string, configured?: string, port?: number): string {
  if (configured !== undefined && configured !== "") {
    const safe = safeGerritReviewUrl(configured);
    if (safe === null) throw new Error("Invalid Gerrit review URL");
    return safe;
  }
  return GERRIT_SITES[host]?.reviewUrl ?? `https://${host}${port === undefined ? "" : `:${port}`}`;
}

/** A validated immutable patch-set ref. The change number alone is not enough. */
export function gerritPatchSet(ref: string | undefined, number: number): number | null {
  const match = /^refs\/changes\/(\d{2})\/(\d+)\/([1-9]\d*)$/.exec(ref ?? "");
  if (match === null || Number(match[2]) !== number || match[1] !== String(number % 100).padStart(2, "0")) return null;
  const patchSet = Number(match[3]);
  return Number.isSafeInteger(patchSet) ? patchSet : null;
}

export function gerritPatchBranch(number: number, patchSet: number): string {
  return `change/${number}/${patchSet}`;
}
