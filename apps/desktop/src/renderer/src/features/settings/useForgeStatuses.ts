import { useEffect, useState } from "react";
import type { ForgeStatus } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

/**
 * Every product's probe, kept current for as long as the caller is mounted.
 *
 * One read on mount, and pushes after that. Main answers `forge:status` from
 * its own cache and never probes on its own, so this costs a single IPC per
 * mount and nothing at all thereafter — the re-checking tick belongs to
 * Settings → Forges, which is the pane a reader sits on while they run
 * `gh auth login` in a terminal. Anywhere else reads what the last probe said.
 *
 * `undefined` means no probe has answered yet, and callers must render it as
 * "we do not know" rather than as a state a forge is in. A failed read leaves
 * it `undefined` for the same reason: the Settings nav has no room to explain a
 * read error, and a dot that guesses is worse than one that is absent. The
 * Forges pane does its own read and reports its own failures — see
 * `ForgesSettings.tsx`, which needs the hosts, the tick and the Re-check button
 * this deliberately does not have.
 */
export function useForgeStatuses(): ForgeStatus[] | undefined {
  const [forges, setForges] = useState<ForgeStatus[] | undefined>();

  useEffect(() => {
    let live = true;
    // A push is newer than the read below by definition, and subscribing first
    // is what keeps one that lands mid-read from being overwritten by it —
    // main pushes on change, so the lost update would persist until the next.
    let pushed = false;
    const unsubscribe = subscribe("forge:statusChanged", ({ forges: next }) => {
      pushed = true;
      setForges(next);
    });
    void dispatch("forge:status", undefined)
      .then((result) => {
        if (!live || pushed || !result.ok) return;
        setForges(result.value.forges);
      })
      // Swallowed, not merely ignored: a rejection escaping a floating promise
      // is an unhandled rejection, which the app reports as a crash. There is
      // nothing to say here — see the note above on why a failed read stays
      // `undefined`.
      .catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return forges;
}
