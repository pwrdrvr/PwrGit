import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RemoteActivity, RemoteActivityKind } from "@pwrgit/shared";
import { dispatch, subscribe, windowProfileId } from "../lib/pwrgit";

/**
 * Live remote Git operations, as one renderer-wide store.
 *
 * Several surfaces read the same set — the toolbar's status popover, the
 * elsewhere-activity toast — and they must agree: two subscriptions would let
 * a toast outlive the popover's view of the same operation.
 */
let activities: RemoteActivity[] = [];
let receivedLive = false;
let started = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function mine(next: RemoteActivity[]): RemoteActivity[] {
  const profileId = windowProfileId();
  // An operation whose repository row could not be read carries no profile.
  // Show it anyway: an unattributed status beats a hidden one.
  return next.filter(
    (activity) => activity.profileId === "" || activity.profileId === profileId
  );
}

function start(): void {
  if (started) return;
  started = true;
  subscribe("remote:activity", (event) => {
    receivedLive = true;
    activities = mine(event.activities);
    notify();
  });
  // A window that opened mid-operation has missed every event so far, and the
  // next one may be minutes away — a silent fetch emits nothing at all.
  void dispatch("remote:activities", undefined).then((result) => {
    if (!result.ok || receivedLive) return;
    activities = mine(result.value);
    notify();
  });
}

function subscribeStore(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): RemoteActivity[] => activities;

/** Every live remote operation in this window's profile. */
export function useRemoteActivities(): RemoteActivity[] {
  return useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
}

/** The operation running against one checkout, if any. */
export function useRemoteActivityFor(
  worktreeId: string | null
): RemoteActivity | null {
  const all = useRemoteActivities();
  return useMemo(
    () =>
      worktreeId === null
        ? null
        : (all.find((activity) => activity.worktreeId === worktreeId) ?? null),
    [all, worktreeId]
  );
}

/**
 * The repo-wide operation of one kind, if any — the half of the registry no
 * single checkout owns.
 *
 * `worktreeId === null` is what makes it repo-wide: a repository fetch and the
 * two halves of the push review are all aimed at a repository rather than at a
 * checkout. `kind` separates the review's own fetch from a repository refresh,
 * which is as far as the record lets a caller go — both take the repository
 * lock, so only one of them can be running, and a caller that finds the other
 * one queued is looking at the reason its own work has not started.
 */
export function useRepoRemoteActivity(
  repoId: string | null,
  kind: RemoteActivityKind | null
): RemoteActivity | null {
  const all = useRemoteActivities();
  return useMemo(
    () =>
      repoId === null || kind === null
        ? null
        : (all.find(
            (activity) =>
              activity.repoId === repoId &&
              activity.worktreeId === null &&
              activity.kind === kind
          ) ?? null),
    [all, kind, repoId]
  );
}

/**
 * A seconds-resolution clock, running only while something is watching one.
 *
 * `useRelativeClock` ticks on the minute, which is right for "3m ago" on a
 * commit row and useless for a readout someone is staring at to decide whether
 * an operation is stuck.
 */
export function useSecondsClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
