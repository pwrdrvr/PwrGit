import { useEffect, useState } from "react";
import type { WorktreeState } from "@pwrgit/shared";
import { dispatch, subscribe } from "../lib/pwrgit";

/**
 * Fetch (and keep fresh) the selected worktree's state. Activating it sets the
 * deep working-tree watch in main; `worktree:changed` events trigger a re-read.
 * The first read is served from cache (no blocking git on the click path).
 */
export function useWorktreeState(
  worktreeId: string | null
): WorktreeState | null {
  const [state, setState] = useState<WorktreeState | null>(null);

  useEffect(() => {
    if (worktreeId === null) {
      setState(null);
      return;
    }
    let active = true;
    const load = (): void => {
      void dispatch("worktree:getState", { worktreeId }).then((r) => {
        if (active && r.ok) setState(r.value);
      });
    };
    void dispatch("worktree:activate", { worktreeId });
    load();
    const off = subscribe("worktree:changed", (payload) => {
      if (payload.worktreeId === worktreeId) load();
    });
    return () => {
      active = false;
      off();
    };
  }, [worktreeId]);

  return state;
}
