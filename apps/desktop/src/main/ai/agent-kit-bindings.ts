// Injection seams binding PwrGit into the host-agnostic @pwrdrvr/agent-kit
// packages (mirrors PwrSnap's adapter): the kit accepts a Logger, an
// OpenExternal, and identity/env strings so it never imports Electron.
import { shell } from "electron";
import type { Logger, OpenExternal } from "@pwrdrvr/agent-core";
import {
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
export const PWRGIT_SERVICE_NAME = "pwrgit";

/** Env for spawning Codex under a chosen auth profile (empty = default ~/.codex). */
export function codexEnvForProfile(
  profile: string | undefined
): NodeJS.ProcessEnv {
  const home =
    (profile !== undefined && profile.length > 0
      ? resolveCodexHomeForProfile(profile)
      : undefined) ?? resolveDefaultCodexHome();
  return { ...process.env, CODEX_HOME: home };
}
