import { useEffect, useState } from "react";
import type { ForgeHostMap, ForgeHostRow } from "@pwrgit/shared";
import { dispatch } from "./pwrgit";

/**
 * The host → forge map the renderer needs to classify a pasted remote URL.
 *
 * `classifyForgeHost` knows `github.com` and `gitlab.com` and nothing else on
 * its own — a hostname is not evidence, so a self-managed instance is only
 * recognised because `gh`/`glab` are signed in to it or the user named it in
 * Settings → Forges. Main owns that list; `forge:hosts` is how it gets here,
 * and this is the renderer's half of the one answer main resolves with through
 * `ForgeHosts.overrides()`.
 *
 * Empty is the correct degraded state, not an error: it means the two SaaS
 * hosts resolve and everything else reads as `other`, which is the same no-op
 * the dialogs already give any unrecognised remote.
 */
export function forgeHostMap(rows: readonly ForgeHostRow[]): ForgeHostMap {
  // Disabled hosts are deliberately kept. "Which forge runs here" and "may we
  // talk to it" are separate questions — main's `overrides()` makes the same
  // choice — and dropping them would make a host the user switched off read as
  // an unknown forge, which is a different message and a different remedy.
  return Object.fromEntries(rows.map((row) => [row.host, row.kind]));
}

/**
 * Read the forge host list once, for as long as the caller is mounted.
 *
 * Deliberately not a refresh: main answers from its cached directory, and the
 * dialogs that use this open on local state (`forge/AGENTS.md`) — a `refresh`
 * here would spawn `gh auth status` and `glab auth status` as the dialog
 * opened, which is the cost that pattern exists to avoid.
 */
export function useForgeHostMap(): ForgeHostMap {
  const [hosts, setHosts] = useState<ForgeHostMap>({});
  useEffect(() => {
    let active = true;
    void dispatch("forge:hosts", {})
      .then((result) => {
        if (active && result.ok) setHosts(forgeHostMap(result.value.hosts));
      })
      // Best-effort, exactly like every other forge read: a rejection leaves
      // the two SaaS hosts resolving rather than failing the dialog.
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return hosts;
}
