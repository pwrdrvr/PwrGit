import { AGENT_ACCESS_PORT } from "./agent-access-protocol.js";
import {
  PairError,
  pairWithPwrGit,
  readAgentAccessHealth,
  type PairResult
} from "./pair-client.js";

/** Config a stdio MCP client needs to launch this server itself. */
export type StdioClientConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type CliIo = {
  /** Human-facing progress. Never stdout: `serve` owns stdout for protocol
   * traffic, and a `--json` caller must be able to pipe stdout straight into
   * a config file. */
  info: (message: string) => void;
  /** Machine-facing result. */
  out: (message: string) => void;
};

export const CLI_USAGE = `pwrgit-mcp — PwrGit's read-only MCP server and pairing helper

Usage:
  pwrgit-mcp serve                 Run the MCP server on stdio (default).
  pwrgit-mcp pair [options]        Ask PwrGit for access and print client config.
  pwrgit-mcp status                Report whether PwrGit is accepting agents.
  pwrgit-mcp help                  Show this message.

Options for \`pair\`:
  --client <name>   Name shown in PwrGit's approval prompt (default "MCP client").
  --role <id>       Role to request, e.g. builtin.local-reader.
  --format <fmt>    mcp-json (default), env, or claude.
  --port <number>   Agent-access port (default ${AGENT_ACCESS_PORT}).

Pairing needs PwrGit running with Settings > Agents > Local agent access on.
Approve the request in the PwrGit window; nothing is granted until you do.`;

export type ParsedArgs = {
  command: "serve" | "pair" | "status" | "help";
  clientName: string;
  roleId?: string;
  format: "mcp-json" | "env" | "claude";
  port: number;
  error?: string;
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: "serve",
    clientName: "MCP client",
    format: "mcp-json",
    port: AGENT_ACCESS_PORT
  };
  const rest = [...argv];
  const first = rest[0];
  if (first !== undefined && !first.startsWith("-")) {
    if (first === "serve" || first === "pair" || first === "status" || first === "help") {
      parsed.command = first;
      rest.shift();
    } else {
      return { ...parsed, command: "help", error: `unknown command: ${first}` };
    }
  } else if (first === "--help" || first === "-h") {
    return { ...parsed, command: "help" };
  }

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === "--help" || flag === "-h") return { ...parsed, command: "help" };
    if (flag === "--client" || flag === "--role" || flag === "--format" || flag === "--port") {
      if (value === undefined) return { ...parsed, command: "help", error: `${flag} needs a value` };
      index += 1;
      if (flag === "--client") parsed.clientName = value;
      if (flag === "--role") parsed.roleId = value;
      if (flag === "--format") {
        if (value !== "mcp-json" && value !== "env" && value !== "claude") {
          return { ...parsed, command: "help", error: `unknown --format: ${value}` };
        }
        parsed.format = value;
      }
      if (flag === "--port") {
        const port = Number.parseInt(value, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          return { ...parsed, command: "help", error: `invalid --port: ${value}` };
        }
        parsed.port = port;
      }
      continue;
    }
    return { ...parsed, command: "help", error: `unknown option: ${flag}` };
  }
  return parsed;
}

/** The stdio config a client needs. The server is invoked through the same
 * executable that is running now, so a copied snippet keeps working whether
 * this came from a global install, npx, or the binary inside PwrGit.app. */
export function stdioClientConfig(
  result: PairResult,
  options: { execPath: string; scriptPath: string }
): StdioClientConfig {
  return {
    command: options.execPath,
    args: [options.scriptPath, "serve"],
    env: {
      PWRGIT_MCP_POLICY_FILE: result.policyFile,
      PWRGIT_MCP_SESSION_TOKEN: result.token
    }
  };
}

export function formatPairOutput(
  result: PairResult,
  config: StdioClientConfig,
  format: ParsedArgs["format"]
): string {
  if (format === "env") {
    return [
      `PWRGIT_MCP_POLICY_FILE=${shellQuote(result.policyFile)}`,
      `PWRGIT_MCP_SESSION_TOKEN=${shellQuote(result.token)}`
    ].join("\n");
  }
  if (format === "claude") {
    // Ready to paste into a terminal: `claude mcp add-json` takes the server
    // body, not the wrapping `mcpServers` object.
    return `claude mcp add-json pwrgit ${shellQuote(JSON.stringify(config))}`;
  }
  return JSON.stringify({ mcpServers: { pwrgit: config } }, null, 2);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function runPair(
  args: ParsedArgs,
  io: CliIo,
  options: {
    execPath: string;
    scriptPath: string;
    fetch?: typeof globalThis.fetch;
  }
): Promise<number> {
  try {
    const result = await pairWithPwrGit({
      clientName: args.clientName,
      ...(args.roleId === undefined ? {} : { requestedRoleId: args.roleId }),
      port: args.port,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      onPending: () => {
        io.info(
          `Waiting for approval in PwrGit for "${args.clientName}". Approve it in Settings > Agents.`
        );
      }
    });
    const config = stdioClientConfig(result, options);
    io.info(
      `Approved as session "${result.session.name}" with role ${result.session.roleId}.`
    );
    io.out(formatPairOutput(result, config, args.format));
    return 0;
  } catch (cause) {
    if (cause instanceof PairError) {
      io.info(cause.message);
      return cause.code === "denied" ? 3 : 1;
    }
    io.info(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}

export async function runStatus(
  args: ParsedArgs,
  io: CliIo,
  options: { fetch?: typeof globalThis.fetch } = {}
): Promise<number> {
  try {
    const health = await readAgentAccessHealth({
      port: args.port,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
    io.out(JSON.stringify(health, null, 2));
    return 0;
  } catch (cause) {
    io.info(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}
