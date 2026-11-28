/**
 * Limited-history ("shallow") clones, shared by main and the renderer.
 *
 * A shallow repository has only the newest commits of each branch it fetched.
 * Git lists the commits whose parents it does not have in `.git/shallow` and
 * pretends they are roots. Nothing here changes which branches or files a
 * checkout has: that is single-branch, partial clone and sparse checkout, which
 * PwrGit does not offer.
 */

/** The largest commit count PwrGit sends as `--depth` or `--deepen`. A depth
 *  past this saves nothing a full clone would not, and a typo of extra digits
 *  should read as a mistake rather than as an enormous fetch. */
export const MAX_HISTORY_DEPTH = 100_000;

/** What the Clone dialog's commit count starts at. */
export const DEFAULT_CLONE_DEPTH = 50;

/** How many older commits "Fetch older commits" asks for, per boundary. */
export const DEEPEN_STEP = 100;

/**
 * A commit count the user typed or a caller sent, or null when it is not one.
 *
 * Only a whole number from 1 to `MAX_HISTORY_DEPTH`, written as plain digits
 * when it is a string. `Number("1e3")`, `"0x10"`, `" 5 "` and `5.0` are all
 * numbers to JavaScript, and each would put a value the user did not write on
 * Git's command line.
 */
export function parseHistoryDepth(value: unknown): number | null {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^[0-9]{1,6}$/.test(value)) {
    parsed = Number(value);
  } else {
    return null;
  }
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_HISTORY_DEPTH
    ? parsed
    : null;
}

export const HISTORY_DEPTH_HINT = `Enter a whole number of commits from 1 to ${MAX_HISTORY_DEPTH.toLocaleString("en-US")}.`;

/** What a shallow repository's History draws. Absent from a complete one. */
export type ShallowHistory = {
  /** Drawn commits whose parents were never downloaded (`.git/shallow`). */
  boundaries: string[];
  /** The remote "Fetch older commits" asks, or null when there is none. */
  remote: string | null;
  /** Branches the remote's fetch refspec names, when it does not fetch every
   *  branch (a single-branch clone). Null when it fetches all of them. */
  fetchesOnly: string[] | null;
};

/** What `remote:deepenHistory` does: N more commits behind each boundary, or
 *  everything the remote has. */
export type DeepenHistoryMode =
  | { kind: "deepen"; commits: number }
  | { kind: "unshallow" };

export type DeepenHistoryResult = {
  remote: string;
  /** Still shallow afterwards: more history exists behind a boundary. */
  shallow: boolean;
  /** False when the repository was already complete and nothing was asked. */
  fetched: boolean;
};

/**
 * True when Git's stderr says the server cannot serve a shallow request.
 *
 * These are Git's own messages: the dumb HTTP transport has no shallow
 * support at all, and an old or restricted smart server may not advertise
 * the `shallow` capability or one of the deepen variants.
 */
export function isShallowUnsupportedError(stderr: string): boolean {
  return /dumb http transport does not support shallow|Server does not support shallow|Server does not support --(?:deepen|shallow-since|shallow-exclude)|does not support shallow (?:clients|capabilities|requests)/i.test(
    stderr
  );
}
