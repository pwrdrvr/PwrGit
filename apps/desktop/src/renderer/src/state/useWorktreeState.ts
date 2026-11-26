import { useEffect, useRef, useState } from "react";
import type { WorktreeState } from "@pwrgit/shared";
import { dispatch, subscribe } from "../lib/pwrgit";
import { samePayload } from "../lib/samePayload";

/**
 * Fetch (and keep fresh) the selected worktree's state. Activating it sets the
 * deep working-tree watch in main; `worktree:changed` events trigger a re-read.
 * The first read is served from cache (no blocking git on the click path).
 */
export function useWorktreeState(
  worktreeId: string | null
): WorktreeState | null {
  const [state, setState] = useState<WorktreeState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (worktreeId === null) {
      if (stateRef.current !== null) {
        stateRef.current = null;
        setState(null);
      }
      return;
    }
    let active = true;
    let request = 0;
    const load = (): void => {
      const mine = ++request;
      void dispatch("worktree:getState", { worktreeId }).then((r) => {
        if (!active || mine !== request || !r.ok) return;
        if (samePayload(stateRef.current, r.value)) return;
        stateRef.current = r.value;
        setState(r.value);
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
