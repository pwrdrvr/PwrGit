import type { CSSProperties } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { stackPositionForPr, type PrSummary, type RepositoryStack, type StackAction, type StackPosition, type StackSnapshot } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { samePayload } from "../../lib/samePayload";

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
  if (stack.closed || lanes?.repoId !== repoId) return;
  // Prefer the lane nearest trunk that is drawn in the current Lineage scope.
  for (const layer of stack.layers) {
    const color = lanes.byBranch.get(layer.branch);
    if (color) return { "--stack-lane": color } as CSSProperties;
  }
}

/** The latest snapshot any surface loaded, per repository. A PR chip reads its
 * stack from here instead of loading a snapshot of its own. */
const known = new Map<string, StackSnapshot>();
const listeners = new Set<() => void>();
let knownVersion = 0;
function remember(repoId: string, snapshot: StackSnapshot) {
  if (samePayload(known.get(repoId), snapshot)) return;
  known.set(repoId, snapshot);
  knownVersion += 1;
  for (const listener of listeners) listener();
}
function subscribeKnown(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The stack this PR is in, open or closed, from snapshots already loaded.
 * Without a repository (a Lineage row, the PR view) any loaded snapshot can
 * answer, but only for a PR that names its forge repository: a bare number
 * would match the wrong repo's PR. */
export function useStackPositionForPr(repoId: string | undefined, pr: Pick<PrSummary, "number" | "repoPath" | "host">, forgeRepo?: string):
  StackPosition | undefined {
  const version = useSyncExternalStore(subscribeKnown, () => knownVersion, () => knownVersion);
  return useMemo(() => {
    if (repoId !== undefined) {
      const snapshot = known.get(repoId);
      if (snapshot) return stackPositionForPr(snapshot.stacks, pr, forgeRepo);
    }
    if (!forgeRepo && !(pr.host && pr.repoPath)) return undefined;
    let historical: StackPosition | undefined;
    for (const snapshot of known.values()) {
      const position = stackPositionForPr(snapshot.stacks, pr, forgeRepo);
      if (position && !position.stack.closed) return position;
      historical ??= position;
    }
    return historical;
  // A PR is the same PR while its number and repository are; its other fields refresh.
  }, [version, repoId, pr.number, pr.repoPath, pr.host, forgeRepo]);
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
  const answerRef = useRef(answer);
  answerRef.current = answer;
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
        if (!live || generation !== stamp || !result.ok) return;
        remember(repoId, result.value);
        const current = answerRef.current;
        if (
          current !== undefined &&
          current.repoId === repoId &&
          current.profileId === profileId &&
          samePayload(current.snapshot, result.value)
        ) {
          return;
        }
        const next = { repoId, profileId, snapshot: result.value };
        answerRef.current = next;
        setAnswer(next);
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
