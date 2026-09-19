// Which ACP strategies a discovery pass may probe, and with which override
// paths. Ported from PwrSnap's `acp-enabled-discovery.ts`.
//
// The strategy table handed to the kit IS the probe list — the kit never
// probes a strategy it was not given — so every filter here is a statement
// about which CLIs PwrGit is willing to spawn.

import {
  BUILT_IN_ACP_STRATEGIES,
  type AcpAgentStrategy,
  type LocalAcpDiscoveryOptions
} from "@pwrdrvr/agent-acp";
import {
  AI_JOB_IDS,
  BUILT_IN_ACP_AGENT_IDS,
  effectiveJobProvider,
  isBuiltInAcpAgentId,
  type AcpAgentPreference,
  type AiProviderSettings,
  type BuiltInAcpAgentId
} from "@pwrgit/shared";

/**
 * The kit's built-in strategies PwrGit offers — `BUILT_IN_ACP_AGENT_IDS`, in
 * that order. Gemini is not in it: the kit still ships its strategy, and
 * PwrGit never probes it, because it does not work for regular accounts and
 * can open auth UI during a probe.
 */
export const PWRGIT_ACP_STRATEGIES: readonly AcpAgentStrategy[] =
  BUILT_IN_ACP_AGENT_IDS.flatMap((id) => {
    const strategy = BUILT_IN_ACP_STRATEGIES.find((candidate) => candidate.id === id);
    return strategy === undefined ? [] : [strategy];
  });

/** A PwrGit ACP strategy by id; undefined for anything PwrGit does not offer,
 *  Gemini included, however the kit answers for it. */
export function pwrgitAcpStrategy(id: string): AcpAgentStrategy | undefined {
  return isBuiltInAcpAgentId(id)
    ? PWRGIT_ACP_STRATEGIES.find((strategy) => strategy.id === id)
    : undefined;
}

function enabledAcpAgentIdSet(settings: AiProviderSettings): Set<string> {
  return new Set(settings.acp.enabledAgentIds);
}

function overridesFromPreferences(
  agents: Partial<Record<BuiltInAcpAgentId, AcpAgentPreference>>,
  enabledIds: Set<string>
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [id, pref] of Object.entries(agents)) {
    if (!enabledIds.has(id)) continue;
    const override = pref?.overridePath?.trim();
    if (override) overrides[id] = override;
  }
  return overrides;
}

function withOverrides(
  strategies: readonly AcpAgentStrategy[],
  overrides: Record<string, string>,
  env: NodeJS.ProcessEnv | undefined
): LocalAcpDiscoveryOptions {
  return {
    strategies,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(env !== undefined ? { env } : {})
  };
}

/** Discovery options for the enabled agents only — what a job may run on. */
export function acpDiscoveryOptionsForEnabledAgents(
  settings: AiProviderSettings,
  env?: NodeJS.ProcessEnv
): LocalAcpDiscoveryOptions {
  const enabledIds = enabledAcpAgentIdSet(settings);
  return withOverrides(
    PWRGIT_ACP_STRATEGIES.filter((strategy) => enabledIds.has(strategy.id)),
    overridesFromPreferences(settings.acp.agents, enabledIds),
    env
  );
}

/**
 * Discovery options for the Settings install scan. Unlike a job's, this probes
 * every PwrGit strategy, so an operator can see an installed-but-disabled agent
 * and turn it on. Override paths stay gated by enablement: a path the operator
 * typed for a disabled agent is not run until they enable it.
 */
export function acpDiscoveryOptionsForInstallScan(
  settings: AiProviderSettings,
  env?: NodeJS.ProcessEnv
): LocalAcpDiscoveryOptions {
  return withOverrides(
    PWRGIT_ACP_STRATEGIES,
    overridesFromPreferences(settings.acp.agents, enabledAcpAgentIdSet(settings)),
    env
  );
}

/** Discovery options for one enabled agent, or null when it is unknown or
 *  disabled — so a caller skips discovery and spawn entirely. */
export function acpDiscoveryOptionsForEnabledAgent(
  settings: AiProviderSettings,
  agentId: string,
  env?: NodeJS.ProcessEnv
): LocalAcpDiscoveryOptions | null {
  if (!enabledAcpAgentIdSet(settings).has(agentId)) return null;
  const strategy = pwrgitAcpStrategy(agentId);
  if (strategy === undefined) return null;
  const override = isBuiltInAcpAgentId(agentId)
    ? settings.acp.agents[agentId]?.overridePath?.trim()
    : undefined;
  return withOverrides(
    [strategy],
    override !== undefined && override.length > 0 ? { [agentId]: override } : {},
    env
  );
}

/** The enabled agents some job actually runs on. Disabled agents never appear:
 *  a job routed to one runs on Codex, so probing it would spawn a CLI nothing
 *  uses. */
export function enabledAcpAgentIdsInUse(settings: AiProviderSettings): BuiltInAcpAgentId[] {
  return [
    ...new Set(
      AI_JOB_IDS.map((jobId) => effectiveJobProvider(settings, jobId)).filter(
        (provider): provider is BuiltInAcpAgentId => provider !== "codex"
      )
    )
  ];
}
