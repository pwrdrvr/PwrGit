// `aiProviders:*` — Settings → AI Providers / AI Features over the command
// bus. Thin on purpose: the service owns discovery and caching, the store owns
// persistence, and this file only narrows what crosses IPC and turns throws
// into Results.

import {
  err,
  isBuiltInAcpAgentId,
  ok,
  type AiProviderSettingsSnapshot,
  type Profile,
  type ProfileId,
  type PwrGitError,
  type Result
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { agentErrorMessage } from "./agent-error-message";
import type { AiProviderService } from "./ai-provider-service";
import {
  sanitizeAiProviderSettingsPatch,
  type AiProviderSettingsStore
} from "./ai-provider-settings";

/**
 * Every call names a profile, and it has to be one that exists. Settings are
 * keyed by profile id in the profile's own `app_meta` namespace, so a write for
 * an id with no profile would persist a row nothing ever deletes — and ids
 * recycle, so the next profile to slug the same would inherit it.
 */
/** `ProfileService`'s lookup: null, never undefined, for an id with no profile
 *  — typed exactly so, because `knownProfile` tests for null. */
type ProfileLookup = { get(id: ProfileId): Profile | null };

function knownProfile(
  profiles: ProfileLookup,
  profileId: unknown
): Result<ProfileId, PwrGitError> {
  if (typeof profileId === "string" && profiles.get(profileId) !== null) {
    return ok(profileId);
  }
  return err({
    kind: "validation",
    code: "unknown_profile",
    message: "AI provider settings need an existing profile."
  });
}

function discoveryFailed(cause: unknown): PwrGitError {
  return {
    kind: "agent",
    code: "discovery_failed",
    message: agentErrorMessage(cause, "Agent discovery failed."),
    cause
  };
}

export function registerAiProviderHandlers(
  bus: CommandBus,
  options: {
    service: AiProviderService;
    store: Pick<AiProviderSettingsStore, "read" | "update">;
    profiles: ProfileLookup;
    /** Fired after a write with the fresh snapshot — index.ts broadcasts it. */
    onChanged: (snapshot: AiProviderSettingsSnapshot) => void;
  }
): void {
  const { service, store, profiles } = options;

  bus.register("aiProviders:read", (req) => {
    const profile = knownProfile(profiles, req.profileId);
    if (!profile.ok) return profile;
    return ok({ profileId: profile.value, settings: store.read(profile.value) });
  });

  bus.register("aiProviders:update", (req) => {
    const profile = knownProfile(profiles, req.profileId);
    if (!profile.ok) return profile;
    const settings = store.update(profile.value, sanitizeAiProviderSettingsPatch(req.patch));
    const snapshot = { profileId: profile.value, settings };
    options.onChanged(snapshot);
    return ok(snapshot);
  });

  bus.register("aiProviders:discoverCodex", async (req) => {
    const profile = knownProfile(profiles, req.profileId);
    if (!profile.ok) return profile;
    try {
      return ok(await service.discoverCodex(profile.value, { force: req.force === true }));
    } catch (cause) {
      return err(discoveryFailed(cause));
    }
  });

  bus.register("aiProviders:discoverAcp", async (req) => {
    const profile = knownProfile(profiles, req.profileId);
    if (!profile.ok) return profile;
    try {
      return ok(await service.discoverAcp(profile.value, { force: req.force === true }));
    } catch (cause) {
      return err(discoveryFailed(cause));
    }
  });

  bus.register("aiProviders:codexModels", async (req) => {
    const profile = knownProfile(profiles, req.profileId);
    if (!profile.ok) return profile;
    return service.codexModels(profile.value, { refresh: req.refresh === true });
  });

  bus.register("aiProviders:acpModels", async (req) => {
    const profile = knownProfile(profiles, req.profileId);
    if (!profile.ok) return profile;
    if (!isBuiltInAcpAgentId(req.agentId)) {
      return err({
        kind: "validation",
        code: "unknown_agent",
        message: "Unknown ACP agent."
      });
    }
    return service.acpModels(profile.value, req.agentId, { refresh: req.refresh === true });
  });

  bus.register("aiProviders:codexAuthProfiles", (req) => {
    const profile = knownProfile(profiles, req.profileId);
    if (!profile.ok) return profile;
    return ok(service.codexAuthProfiles(profile.value));
  });

  bus.register("aiProviders:codexLogin", async (req) => {
    const profile = knownProfile(profiles, req.profileId);
    if (!profile.ok) return profile;
    return service.codexLogin(profile.value);
  });
}
