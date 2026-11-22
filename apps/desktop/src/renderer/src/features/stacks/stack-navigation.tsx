import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { RepositoryStack, StackSnapshot } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

export type StackPick = { repoId: string; stack: RepositoryStack };
export const StackNavigationContext = createContext<{
  pick: StackPick | null;
  select: (pick: StackPick) => void;
} | null>(null);
export const useStackNavigation = () => useContext(StackNavigationContext);

const pending = new Map<string, ReturnType<typeof loadSnapshot>>();
function loadSnapshot(repoId: string, profileId: string) {
  return dispatch("stack:list", { repoId, profileId });
}

function readSnapshot(repoId: string, profileId: string) {
  const key = JSON.stringify([repoId, profileId]);
  const current = pending.get(key);
  if (current) return current;
  const next = loadSnapshot(repoId, profileId).finally(() => pending.delete(key));
  pending.set(key, next);
  return next;
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
    const load = () => {
      const stamp = ++generation;
      void readSnapshot(repoId, profileId).then(result => {
        if (live && generation === stamp && result.ok) setAnswer({ repoId, profileId, snapshot: result.value });
      }).catch(() => undefined);
    };
    const invalidate = (payload: { repoId: string }) => {
      if (payload.repoId !== repoId) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 50);
    };
    load();
    const stop = [
      subscribe("graph:changed", invalidate),
      subscribe("pr:openChanged", invalidate),
      subscribe("pr:changed", invalidate),
    ];
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.clearTimeout(timer);
      for (const off of stop) off();
      window.removeEventListener("focus", load);
    };
  }, [repoId, profileId, revision]);
  return { snapshot: answer?.repoId === repoId && answer?.profileId === profileId ? answer?.snapshot : undefined, refresh };
}
