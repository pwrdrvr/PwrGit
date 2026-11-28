import {
  forgeProductFor,
  HISTORY_DEPTH_HINT,
  parseHistoryDepth,
  type CloneProtocol,
  type ForgeHost
} from "@pwrgit/shared";

/**
 * The Clone dialog's "Recent history only" row, decided outside JSX.
 *
 * Off is the default and means a full clone, exactly as before. On sends
 * `depth` — or blocks Clone with the reason in the row. It never quietly
 * becomes a full clone: a row that is on while its source cannot honour it
 * stays on (and stays uncheckable) and says why. Design:
 * `design/Shallow Clones - UX Review.dc.html`, turn 1.
 */
export type CloneHistoryChoice = {
  /** What to send as `repo:clone`'s `depth`, or undefined for full history. */
  depth: number | undefined;
  /** Why the option cannot apply to this source, or null when it can. */
  unavailable: string | null;
  /** The row's error line: a bad count, or `unavailable` while it is on. */
  error: string | null;
  /** True while the row is on and the clone could not honour it. */
  blocksSubmit: boolean;
  /** The checkbox may change: always while on (so it can be turned off). */
  toggleDisabled: boolean;
};

export const CLONE_HISTORY_DETAIL =
  "Download only the latest commits of each branch and tag instead of the whole history. Faster and smaller for long-lived projects; you can fetch older history later.";

export const CLONE_HISTORY_ON_DETAIL =
  "Older commits aren’t downloaded. History and blame stop at the boundary, and a merge or rebase on an older base may need more history first. Fetch more any time from History.";

export const CLONE_HISTORY_LOCAL_NOTE =
  "From a local path this copies through Git’s file:// transport, so objects aren’t hard-linked.";

export function cloneHistoryChoice(input: {
  on: boolean;
  text: string;
  forking: boolean;
  local: boolean;
  protocol: CloneProtocol;
  host: ForgeHost;
}): CloneHistoryChoice {
  let unavailable: string | null = null;
  if (input.forking) {
    unavailable = "Not available when cloning your fork: it is cloned with full history.";
  } else if (!input.local && input.protocol === "cli") {
    const product = forgeProductFor(input.host);
    if (product !== null && !product.cliCloneTakesGitOptions) {
      unavailable = `Not available with the ${product.label} CLI. Choose SSH or HTTPS.`;
    }
  }
  if (!input.on) {
    return {
      depth: undefined,
      unavailable,
      error: null,
      blocksSubmit: false,
      toggleDisabled: unavailable !== null
    };
  }
  if (unavailable !== null) {
    return { depth: undefined, unavailable, error: unavailable, blocksSubmit: true, toggleDisabled: false };
  }
  const depth = parseHistoryDepth(input.text.trim());
  if (depth === null) {
    return { depth: undefined, unavailable, error: HISTORY_DEPTH_HINT, blocksSubmit: true, toggleDisabled: false };
  }
  return { depth, unavailable, error: null, blocksSubmit: false, toggleDisabled: false };
}
