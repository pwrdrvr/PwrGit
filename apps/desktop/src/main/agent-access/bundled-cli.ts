import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type BundledCliLaunch = {
  command: string;
  args: string[];
  /** Env every client must set alongside its own token. */
  env: Record<string, string>;
};

/** Locates the single-file MCP server shipped inside the app.
 *
 * A packaged build carries it in `process.resourcesPath`; a dev run has it
 * wherever `pnpm --filter @pwrgit/mcp-server build:bundle` wrote it. Returns
 * undefined rather than a guessed path, so a caller can say "build it first"
 * instead of handing out a config that fails at launch. */
export function resolveBundledCliPath(options: {
  resourcesPath?: string | undefined;
  packaged: boolean;
  appPath?: string | undefined;
  exists?: (path: string) => boolean;
}): string | undefined {
  const fileExists = options.exists ?? existsSync;
  const candidates: string[] = [];
  if (options.resourcesPath !== undefined) {
    candidates.push(join(options.resourcesPath, "pwrgit-mcp.mjs"));
  }
  if (!options.packaged && options.appPath !== undefined) {
    candidates.push(
      resolve(
        options.appPath,
        "../../packages/mcp-server/dist-bundle/pwrgit-mcp.mjs"
      )
    );
  }
  return candidates.find((candidate) => fileExists(candidate));
}

/** The launch a stdio MCP client should use.
 *
 * The command is the app's own executable rather than a `node` on PATH:
 * ELECTRON_RUN_AS_NODE turns it into the Node that shipped with the app, so a
 * machine with no Node — or the wrong Node — still works. */
export function bundledCliLaunch(options: {
  execPath: string;
  scriptPath: string;
  policyFile: string;
}): BundledCliLaunch {
  return {
    command: options.execPath,
    args: [options.scriptPath, "serve"],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      PWRGIT_MCP_POLICY_FILE: options.policyFile
    }
  };
}

/** Complete, paste-ready client config. The caller supplies the token from a
 * freshly minted Session; it is never read back out of the policy file. */
export function bundledCliMcpConfig(
  launch: BundledCliLaunch,
  token: string
): string {
  return JSON.stringify(
    {
      mcpServers: {
        pwrgit: {
          command: launch.command,
          args: launch.args,
          env: { ...launch.env, PWRGIT_MCP_SESSION_TOKEN: token }
        }
      }
    },
    null,
    2
  );
}
