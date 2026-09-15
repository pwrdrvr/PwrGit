// Injection seams binding PwrGit into the host-agnostic @pwrdrvr/agent-kit
// packages (mirrors PwrSnap's adapter): the kit accepts a Logger, an
// OpenExternal, and identity/env strings so it never imports Electron.
import { shell } from "electron";
import type { Logger, OpenExternal } from "@pwrdrvr/agent-core";
import {
  discoverCodexAuthProfiles,
  resolveCodexHomeForProfile,
  resolveDefaultCodexHome
} from "@pwrdrvr/codex-discovery";

export function toAgentKitLogger(scope: string): Logger {
  const prefix = `[pwrgit:${scope}]`;
  return {
    debug: (m, f) =>
      f === undefined ? console.debug(prefix, m) : console.debug(prefix, m, f),
    info: (m, f) =>
      f === undefined ? console.info(prefix, m) : console.info(prefix, m, f),
    warn: (m, f) =>
      f === undefined ? console.warn(prefix, m) : console.warn(prefix, m, f),
    error: (m, f) =>
      f === undefined ? console.error(prefix, m) : console.error(prefix, m, f)
  };
}

export const openExternal: OpenExternal = async (url: string): Promise<void> => {
  await shell.openExternal(url);
};

export const PWRGIT_CLIENT_NAME = "pwrgit";
export const PWRGIT_CLIENT_TITLE = "PwrGit";
export const PWRGIT_SERVICE_NAME = "pwrgit";
export const PWRGIT_AGENT_PROFILE_ENV = "PWRGIT_PROFILE_ID";

/** Env for spawning Codex under a chosen auth profile (empty = default ~/.codex). */
export function codexEnvForProfile(
  profile: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  homeDir?: string
): NodeJS.ProcessEnv {
  const options =
    homeDir === undefined ? { env: baseEnv } : { env: baseEnv, homeDir };
  const home =
    (profile !== undefined && profile.length > 0
      ? resolveCodexHomeForProfile(profile, options)
      : undefined) ?? resolveDefaultCodexHome(options);
  return { ...baseEnv, CODEX_HOME: home };
}

/**
 * Keep one agent environment per PwrGit profile without making a same-named
 * Codex auth profile mandatory. A matching, authenticated Codex profile wins;
 * otherwise the user's default Codex account is used. The explicit profile id
 * keeps pools and diagnostics scoped even when two profiles share that account.
 */
export function agentEnvForPwrGitProfile(
  profileId: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  homeDir?: string
): NodeJS.ProcessEnv {
  const authProfiles = discoverCodexAuthProfiles({
    configuredProfile: profileId,
    env: baseEnv,
    ...(homeDir !== undefined ? { homeDir } : {})
  });
  const matching = authProfiles.profiles.find(
    (profile) => profile.name === profileId && profile.hasAuthFile
  );
  return {
    ...codexEnvForProfile(matching?.name, baseEnv, homeDir),
    [PWRGIT_AGENT_PROFILE_ENV]: profileId
  };
}
