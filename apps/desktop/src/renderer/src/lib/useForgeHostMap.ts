import { useEffect, useState } from "react";
import type { ForgeHostMap } from "@pwrgit/shared";
import { dispatch, subscribe } from "./pwrgit";

/**
 * The host → forge map the renderer needs to classify a pasted remote URL.
 *
 * `classifyForgeHost` knows `github.com` and `gitlab.com` and nothing else on
 * its own — a hostname is not evidence, so a self-managed instance is only
 * recognised because `gh`/`glab` are signed in to it or the user named it in
 * Settings → Forges. Main owns that list and resolves with it; `forge:hosts`
 * ships the map itself rather than the settings rows, because the rows are
 * "what has a settings row" and the map is "what resolves" — an env allowlist
 * (`PWRGIT_{GITHUB,GITLAB}_HOSTS`) names hosts that are in the second and not
 * the first, and a renderer deriving one from the other disagreed with main
 * about exactly those hosts.
 *
 * Empty is the correct degraded state, not an error: it means the two SaaS
 * hosts resolve and everything else reads as `other`, which is the same no-op
 * the dialogs already give any unrecognised remote.
 */
export function useForgeHostMap(): ForgeHostMap {
  // `sameHosts` below preserves this object's identity for as long as the map
  // is equal, including while it is empty, so no shared constant is needed.
  const [hosts, setHosts] = useState<ForgeHostMap>({});
  useEffect(() => {
    let active = true;
    // Reads are not ordered by the IPC layer, and main emits
    // `forge:statusChanged` in bursts — the boot probe, the debounced
    // re-probe, the Hosts pane's Re-check. Without a sequence number an early
    // read taken before enumeration landed could resolve last and pin the
    // empty map for the dialog's whole lifetime, which is the exact degraded
    // state this hook exists to end.
    let issued = 0;
    let applied = 0;
    const read = (): void => {
      const seq = ++issued;
      void dispatch("forge:hosts", {})
        .then((result) => {
          if (!active || !result.ok || seq <= applied) return;
          applied = seq;
          const next = result.value.overrides;
          // Identity matters: `hosts` is a dependency of the dialogs' memos
          // and of their debounced check effect, so storing an equal-but-new
          // object costs a redundant render and a duplicate CLI round trip.
          setHosts((current) => (sameHosts(current, next) ? current : next));
        })
        // Best-effort, exactly like every other forge read: a rejection leaves
        // the two SaaS hosts resolving rather than failing the dialog.
        .catch(() => {});
    };
    read();
    // Main enumerates hosts in the background at boot (two CLI spawns), so a
    // dialog opened in the first second would otherwise cache an empty map for
    // its whole lifetime. `forge:statusChanged` is what main already uses to
    // re-read the directory, so it is the signal that the list may have moved.
    const stop = subscribe("forge:statusChanged", read);
    return () => {
      active = false;
      stop();
    };
  }, []);
  return hosts;
}

function sameHosts(a: ForgeHostMap, b: ForgeHostMap): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key])
  );
}
