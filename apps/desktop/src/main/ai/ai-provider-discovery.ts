// Pure mappings from the agent kit's discovery results onto the shapes
// Settings renders. Split from the service so each rule has a test that needs
// no spawn: which Codex is "Using", what a sign-in check means, and which ACP
// install is active.

import type { DiscoveredAcpAgentGroup } from "@pwrdrvr/agent-acp";
import type {
  CodexAuthStatusResponse,
  CodexDiscoverySnapshot
} from "@pwrdrvr/codex-discovery";
import {
  BUILT_IN_ACP_AGENT_IDS,
  builtInAcpAgentDisplayName,
  type AcpAgentDiscovery,
  type AcpAgentDiscoveryEntry,
  type AcpAgentInstance,
  type AcpAgentPreference,
  type BuiltInAcpAgentId,
  type CodexAuthState,
  type CodexCandidate
} from "@pwrgit/shared";
import { pwrgitAcpStrategy } from "./acp-enabled-discovery";
import { resolveActiveAcpInstance } from "./acp-instance-resolver";

/** Every candidate the kit reported, in its order — pinned and env first, then
 *  the auto candidates newest first. */
export function toCodexCandidates(snapshot: CodexDiscoverySnapshot): CodexCandidate[] {
  return snapshot.candidates.map((candidate) => {
    const failureReason = candidate.failureReason ?? candidate.versionFailureReason;
    return {
      path: candidate.command,
      source: candidate.source,
      version: candidate.version ?? null,
      available: candidate.executable,
      ...(candidate.executable || failureReason === undefined ? {} : { failureReason })
    };
  });
}

/** The candidate the kit selected — the binary the next spawn runs. */
export function selectedCodexCandidate(
  snapshot: CodexDiscoverySnapshot
): { command: string; version?: string } | null {
  const selected = snapshot.candidates.find((candidate) => candidate.selected);
  if (selected === undefined) return null;
  return {
    command: selected.command,
    ...(selected.version !== undefined ? { version: selected.version } : {})
  };
}

/** Why a sign-in check has no verdict, in the words the row shows. */
function unansweredDetail(outcome: CodexAuthStatusResponse["outcome"]): string | undefined {
  switch (outcome) {
    case "timed_out":
      return "Codex did not answer the sign-in check in time.";
    case "spawn_failed":
      return "Codex could not be started to check sign-in.";
    case "aborted":
      return "The sign-in check was cancelled.";
    default:
      return undefined;
  }
}

/**
 * What a `codex login status` answer means for the row.
 *
 * Only an answered probe is a verdict. A probe that timed out, was abandoned,
 * or never spawned says nothing about whether the profile is signed in, so it
 * reads as a failed check — "look at this" — rather than as signed out, which
 * would send the operator to re-login an account that may be fine.
 */
export function toCodexAuthState(
  response: CodexAuthStatusResponse,
  profileLabel: string
): CodexAuthState {
  const answered = response.outcome === undefined || response.outcome === "answered";
  const status = answered ? response.status : "failed";
  const detail = response.detail?.trim() || unansweredDetail(response.outcome);
  return {
    status,
    profile: response.profile,
    profileLabel,
    codexHome: response.codexHome,
    ...(response.email !== undefined ? { email: response.email } : {}),
    ...(response.planType !== undefined ? { planType: response.planType } : {}),
    ...(detail !== undefined && detail.length > 0 ? { detail: detail.slice(0, 240) } : {})
  };
}

/** A short hint for an agent that is not installed, pointing at its home when
 *  the kit knows one. */
function installHint(id: BuiltInAcpAgentId): string {
  const url = pwrgitAcpStrategy(id)?.repositoryUrl;
  return url !== undefined && url.length > 0 ? `Not installed — see ${url}` : "Not installed";
}

export function toAcpInstances(group: DiscoveredAcpAgentGroup): AcpAgentInstance[] {
  return group.instances.map((inst) => ({
    command: inst.command,
    source: inst.source,
    ...(inst.version !== undefined ? { version: inst.version } : {})
  }));
}

/**
 * One entry per PwrGit agent, installed or not, with the active install
 * resolved from the operator's preference. The kit returns groups only for
 * agents it found; everything else becomes a not-installed row with a hint.
 */
export function toAcpDiscovery(
  groups: readonly DiscoveredAcpAgentGroup[],
  agents: Partial<Record<BuiltInAcpAgentId, AcpAgentPreference>>
): AcpAgentDiscovery {
  const byId = new Map(groups.map((group) => [group.strategyId, group] as const));
  return {
    agents: BUILT_IN_ACP_AGENT_IDS.map((id): AcpAgentDiscoveryEntry => {
      const displayName = pwrgitAcpStrategy(id)?.displayName ?? builtInAcpAgentDisplayName(id);
      const group = byId.get(id);
      if (group === undefined || group.instances.length === 0) {
        return { id, displayName, installed: false, instances: [], detail: installHint(id) };
      }
      const instances = toAcpInstances(group);
      const active = resolveActiveAcpInstance(instances, agents[id]);
      return {
        id,
        displayName,
        installed: true,
        instances,
        activeCommand: active.command,
        detail: active.command,
        ...(active.version !== undefined ? { version: active.version } : {})
      };
    })
  };
}
