// What clicking the AI switch does. Ported from PwrSnap's
// `resolveLibraryAiToggleAction` (its Library status-bar switch); PwrGit's
// switch sits at the bottom of the sidebar and gates every AI feature for the
// window's profile rather than capture enrichment.
//
// Pure, so the sidebar switch and Settings → AI Features cannot disagree about
// when the disclosure is shown.

import {
  jobProviders,
  type AcpAgentDiscovery,
  type AiProviderId,
  type AiProviderSettings,
  type CodexProviderDiscovery
} from "@pwrgit/shared";

export type AiToggleAction = "disable" | "configure" | "consent" | "enable";

/**
 * - on → `disable`, always; turning AI off never needs anything.
 * - a provider the features run on is known NOT to be ready → `configure`:
 *   switching on something that cannot run would only fail later, somewhere
 *   less helpful than AI Providers.
 * - never accepted the disclosure → `consent`.
 * - otherwise → `enable`.
 *
 * `providerReady: undefined` (not checked, or still checking) proceeds rather
 * than blocking, as PwrSnap's does: the check is advice, and main's resolver
 * is what actually refuses a job that cannot run.
 */
export function resolveAiToggleAction(params: {
  enabled: boolean;
  consentAcceptedAt: string | null;
  providerReady: boolean | undefined;
}): AiToggleAction {
  if (params.enabled) return "disable";
  if (params.providerReady === false) return "configure";
  if (params.consentAcceptedAt === null) return "consent";
  return "enable";
}

/**
 * The first provider a feature runs on that cannot run, `null` when every one
 * can, or `undefined` while any answer is missing.
 *
 * Codex counts as ready when a binary resolved and it is not known to be
 * signed out; a check that FAILED is not proof of signed-out, so it does not
 * block. An ACP agent is ready when its install passed the probe.
 */
export function firstUnreadyAiProvider(
  settings: AiProviderSettings,
  codex: CodexProviderDiscovery | null,
  acp: AcpAgentDiscovery | null
): AiProviderId | null | undefined {
  let unknown = false;
  for (const provider of jobProviders(settings)) {
    if (provider === "codex") {
      if (codex === null) unknown = true;
      else if (codex.resolvedPath === null || codex.auth?.status === "unauthenticated") {
        return provider;
      }
      continue;
    }
    if (acp === null) {
      unknown = true;
      continue;
    }
    if (acp.agents.find((agent) => agent.id === provider)?.installed !== true) return provider;
  }
  return unknown ? undefined : null;
}
