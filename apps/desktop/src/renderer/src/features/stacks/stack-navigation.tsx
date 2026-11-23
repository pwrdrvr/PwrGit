import type { CSSProperties } from "react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { RepositoryStack, StackAction, StackSnapshot } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

export type StackPick = { repoId: string; stack: RepositoryStack; action?: StackAction; branch?: string | undefined };
export type StackLaneColors = {
  repoId: string;
  worktreeId: string;
  byBranch: ReadonlyMap<string, string>;
};

export const StackNavigationContext = createContext<{
  pick: StackPick | null;
  select: (pick: StackPick) => void;
  lanes?: StackLaneColors | undefined;
} | null>(null);
export const useStackNavigation = () => useContext(StackNavigationContext);

export function useStackLaneStyle(repoId: string, stack: RepositoryStack): CSSProperties | undefined {
  const lanes = useStackNavigation()?.lanes;
  if (lanes?.repoId !== repoId) return;
  // Prefer the lane nearest trunk that is drawn in the current Lineage scope.
  for (const layer of stack.layers) {
    const color = lanes.byBranch.get(layer.branch);
    if (color) return { "--stack-lane": color } as CSSProperties;
  }
}

type Read = ReturnType<typeof loadSnapshot>;
const pending = new Map<string, { result: Read; next?: Read }>();
function loadSnapshot(repoId: string, profileId: string) {
  return dispatch("stack:list", { repoId, profileId });
}

function readSnapshot(repoId: string, profileId: string, fresh = false): Read {
  const key = JSON.stringify([repoId, profileId]);
  const current = pending.get(key);
  if (current) {
    if (!fresh) return current.next ?? current.result;
    // A pending dispatch may have captured its data before the invalidation.
    const reread = () => readSnapshot(repoId, profileId);
    return current.next ??= current.result.then(reread, reread);
  }
  const result = loadSnapshot(repoId, profileId).finally(() => pending.delete(key));
  pending.set(key, { result });
  return result;
}

export function useStackSnapshot(repoId: string | undefined, profileId: string | undefined) {
  const [answer, setAnswer] = useState<{ repoId: string; profileId: string; snapshot: StackSnapshot }>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!repoId || !profileId || !window.pwrgit) return;
    let live = true;
    let timer: number | undefined;
    let generation = 0;
    const load = (fresh: boolean) => {
      const stamp = ++generation;
      void readSnapshot(repoId, profileId, fresh).then(result => {
        if (live && generation === stamp && result.ok) setAnswer({ repoId, profileId, snapshot: result.value });
      }).catch(() => undefined);
    };
    const invalidate = (payload: { repoId: string }) => {
      if (payload.repoId !== repoId) return;
      ++generation;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => load(true), 50);
    };
    load(revision > 0);
    const focus = () => load(true);
    const stop = [
      subscribe("graph:changed", invalidate),
      subscribe("pr:openChanged", invalidate),
      subscribe("pr:changed", invalidate),
      subscribe("stack:changed", event => { if (event.profileId === profileId) invalidate(event); }),
    ];
    window.addEventListener("focus", focus);
    return () => {
      live = false;
      window.clearTimeout(timer);
      for (const off of stop) off();
      window.removeEventListener("focus", focus);
    };
  }, [repoId, profileId, revision]);
  return { snapshot: answer?.repoId === repoId && answer?.profileId === profileId ? answer?.snapshot : undefined, refresh };
}
