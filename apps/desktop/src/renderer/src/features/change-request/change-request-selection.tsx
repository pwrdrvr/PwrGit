import { createContext, useContext } from "react";
import type { ChangeRequestEntry } from "@pwrgit/shared";

/**
 * A change request picked in the sidebar — the second kind of place the main
 * pane can show, beside a worktree. `entry` is the list row it was picked
 * from, so the header paints from the cache before git answers.
 *
 * `via` is how it was reached: a pointer click is intent enough to fetch a
 * head that is not here, an arrow key passing over the row is not (the view
 * waits for the selection to rest first).
 */
export type ChangeRequestPick = {
  repoId: string;
  entry: ChangeRequestEntry;
  via: "pointer" | "keyboard";
  /** More than one remote lists change requests here, so the view says
   *  which one this is. */
  manyRemotes: boolean;
};

/** One change request in one repository: its forge repository and number. */
export function changeRequestPickKey(repoId: string, entry: ChangeRequestEntry): string {
  return `${repoId}\n${entry.forgeRepo}#${entry.pr.number}`;
}

export type ChangeRequestSelection = {
  /** `changeRequestPickKey` of the change request on screen, if one is. */
  selectedKey: string | null;
  select: (pick: ChangeRequestPick) => void;
};

const NONE: ChangeRequestSelection = { selectedKey: null, select: () => {} };

/**
 * Carried by context rather than threaded through Sidebar → RepoRow →
 * RepoRefsSections: only the change-request rows read it, and the worktree
 * rows, to stand down their own selected look while a change request has it.
 * App memoizes the value, so a render that changes neither field re-renders
 * no consumer.
 */
export const ChangeRequestSelectionContext = createContext<ChangeRequestSelection>(NONE);

export function useChangeRequestSelection(): ChangeRequestSelection {
  return useContext(ChangeRequestSelectionContext);
}
