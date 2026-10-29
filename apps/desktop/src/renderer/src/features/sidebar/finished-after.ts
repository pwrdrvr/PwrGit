import { createContext, useEffect, useState } from "react";
import { isWorktreeFinishedAfterDays, STALE_AGE_DAYS } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

/**
 * Days without commits before a branch merged into the default branch counts
 * as finished (General › `worktreeFinishedAfterDays`). The sidebar provides it
 * so a worktree row's stale mark and the Stale lens judge by the same rule as
 * the maintenance sweep.
 */
export const FinishedAfterDaysContext = createContext<number>(STALE_AGE_DAYS);

const readDays = (value: unknown): number =>
  isWorktreeFinishedAfterDays(value) ? value : STALE_AGE_DAYS;

/** The saved setting, following `settings:changed` from any window. */
export function useFinishedAfterDaysSetting(): number {
  const [days, setDays] = useState<number>(STALE_AGE_DAYS);
  useEffect(() => {
    let live = true;
    // A change event is newer than the first read, which may answer later.
    let changed = false;
    const off = subscribe("settings:changed", (snapshot) => {
      changed = true;
      setDays(readDays(snapshot.general.worktreeFinishedAfterDays));
    });
    void dispatch("settings:read", undefined)
      .then((result) => {
        if (live && !changed && result.ok)
          setDays(readDays(result.value.general.worktreeFinishedAfterDays));
      })
      .catch(() => undefined);
    return () => {
      live = false;
      off();
    };
  }, []);
  return days;
}
