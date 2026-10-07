import { useCallback, useEffect, useRef, useState } from "react";
import type { CommitIdentityInspection, MachineGitIdentity } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

/**
 * Who a commit in this checkout will be recorded as, resolved by Git.
 *
 * Re-resolved, never polled: on select, on window focus (a config edited in a
 * terminal a moment ago), on a profile or identity change, when the checkout's
 * HEAD moves (a branch switch, pull or rebase inside PwrGit, which Amend's
 * "keeps author" preview reads), and whenever the caller asks — the commit box
 * asks after every commit. Main collapses concurrent asks for one checkout
 * into a single inspection.
 */
export function useCommitIdentity(
  worktreeId: string | null,
  /** The checkout's HEAD as last computed; a change re-resolves. */
  head?: string | null
): {
  inspection: CommitIdentityInspection | null;
  refresh: () => void;
} {
  const [inspection, setInspection] = useState<CommitIdentityInspection | null>(null);
  const load = useRef<() => void>(() => undefined);

  useEffect(() => {
    setInspection(null);
    if (worktreeId === null) {
      load.current = () => undefined;
      return;
    }
    let live = true;
    let sequence = 0;
    const run = (): void => {
      const request = ++sequence;
      void dispatch("identity:inspect", { worktreeId })
        .then((result) => {
          if (!live || request !== sequence) return;
          // A refusal (the checkout went missing) drops back to the provisional
          // footer rather than keeping another state's answer on screen.
          setInspection(result.ok ? result.value : null);
        })
        .catch(() => {
          if (live && request === sequence) setInspection(null);
        });
    };
    load.current = run;
    run();
    const offIdentity = subscribe("identity:changed", run);
    const offProfile = subscribe("profile:changed", run);
    window.addEventListener("focus", run);
    return () => {
      live = false;
      offIdentity();
      offProfile();
      window.removeEventListener("focus", run);
    };
  }, [worktreeId]);

  // Not on first sight: the effect above has just asked.
  const seenHead = useRef(head);
  useEffect(() => {
    if (seenHead.current === head) return;
    seenHead.current = head;
    load.current();
  }, [head]);

  const refresh = useCallback(() => load.current(), []);
  return { inspection, refresh };
}

/**
 * Git's identity with no repository in the way, for Settings. Never claims the
 * launch notice — that is `GitIdentityNotice`'s job, in one window.
 */
export function useMachineIdentity(): {
  machine: MachineGitIdentity | null;
  refresh: () => void;
} {
  const [machine, setMachine] = useState<MachineGitIdentity | null>(null);
  const load = useRef<() => void>(() => undefined);

  useEffect(() => {
    let live = true;
    let sequence = 0;
    const run = (): void => {
      const request = ++sequence;
      void dispatch("identity:machine", {})
        .then((result) => {
          if (live && request === sequence && result.ok) setMachine(result.value);
        })
        .catch(() => undefined);
    };
    load.current = run;
    run();
    const off = subscribe("identity:changed", run);
    window.addEventListener("focus", run);
    return () => {
      live = false;
      off();
      window.removeEventListener("focus", run);
    };
  }, []);

  const refresh = useCallback(() => load.current(), []);
  return { machine, refresh };
}
