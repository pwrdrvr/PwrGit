// Single source of truth for "which discovered ACP install is active" — used by
// discovery (to mark the active install in Settings) and by job resolution (to
// spawn the chosen one). Keeping the precedence in one place means the badge
// the operator sees and the binary that actually runs cannot disagree. Ported
// from PwrSnap.

import type { AcpAgentInstance, AcpAgentPreference } from "@pwrgit/shared";

/**
 * Pick the active install from a discovered list, honoring the operator's
 * preference. Precedence:
 *   1. An override install (discovery probes the override path and tags it
 *      `source: "override"`), so a manual path wins while it is installed.
 *   2. The pinned `selectedPath`, while it is still among the installs.
 *   3. The first discovered install (auto).
 *
 * `instances` MUST be non-empty (callers only resolve installed agents).
 */
export function resolveActiveAcpInstance(
  instances: readonly AcpAgentInstance[],
  pref: AcpAgentPreference | undefined
): AcpAgentInstance {
  const override = instances.find((inst) => inst.source === "override");
  if (override !== undefined) return override;

  const selected = pref?.selectedPath?.trim();
  if (selected) {
    const match = instances.find((inst) => inst.command === selected);
    if (match !== undefined) return match;
  }

  // Non-empty by contract; fall back to the first if a caller violates it.
  return instances[0] as AcpAgentInstance;
}
