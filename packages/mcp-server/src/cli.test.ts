import { describe, expect, it, vi } from "vitest";
import {
  formatPairOutput,
  parseArgs,
  runPair,
  stdioClientConfig,
  type CliIo
} from "./cli.js";
import { AGENT_ACCESS_PORT } from "./agent-access-protocol.js";
import type { PairResult } from "./pair-client.js";

const result: PairResult = {
  token: "pgmcp_test-token",
  policyFile: "/Users/me/Library/Application Support/PwrGit/mcp-policy.json",
  mcpUrl: `http://127.0.0.1:${AGENT_ACCESS_PORT}/mcp`,
  session: { id: "session_1", name: "Claude Code", roleId: "builtin.local-reader" }
};

const config = stdioClientConfig(result, {
  execPath: "/usr/bin/node",
  scriptPath: "/opt/pwrgit/bin.js"
});

type RecordingIo = CliIo & { infoLines: string[]; outLines: string[] };

function recordingIo(): RecordingIo {
  const infoLines: string[] = [];
  const outLines: string[] = [];
  return {
    infoLines,
    outLines,
    info: (message: string) => void infoLines.push(message),
    out: (message: string) => void outLines.push(message)
  };
}

describe("argument parsing", () => {
  it("defaults to serve so an existing stdio config keeps working", () => {
    expect(parseArgs([]).command).toBe("serve");
  });

  it("reads pair options", () => {
    const args = parseArgs([
      "pair",
      "--client",
      "Claude Code",
      "--role",
      "builtin.local-reader",
      "--format",
      "claude",
      "--port",
      "51999"
    ]);
    expect(args).toMatchObject({
      command: "pair",
      clientName: "Claude Code",
      roleId: "builtin.local-reader",
      format: "claude",
      port: 51999
    });
  });

  it("reports an unknown command instead of silently serving", () => {
    const args = parseArgs(["frobnicate"]);
    expect(args.command).toBe("help");
    expect(args.error).toMatch(/unknown command/u);
  });

  it("rejects a malformed port", () => {
    expect(parseArgs(["pair", "--port", "nope"]).error).toMatch(/invalid --port/u);
  });

  it("rejects a flag with no value", () => {
    expect(parseArgs(["pair", "--client"]).error).toMatch(/needs a value/u);
  });
});

describe("pair output formats", () => {
  it("emits mcp-json a client can paste whole", () => {
    const parsed = JSON.parse(formatPairOutput(result, config, "mcp-json")) as {
      mcpServers: { pwrgit: { args: string[]; env: Record<string, string> } };
    };
    expect(parsed.mcpServers.pwrgit.args).toEqual(["/opt/pwrgit/bin.js", "serve"]);
    expect(parsed.mcpServers.pwrgit.env).toEqual({
      PWRGIT_MCP_POLICY_FILE: result.policyFile,
      PWRGIT_MCP_SESSION_TOKEN: result.token
    });
  });

  it("emits an env pair with shell quoting for a path that has spaces", () => {
    const env = formatPairOutput(result, config, "env");
    expect(env).toContain("PWRGIT_MCP_SESSION_TOKEN='pgmcp_test-token'");
    expect(env).toContain("'/Users/me/Library/Application Support/PwrGit/mcp-policy.json'");
  });

  it("emits a runnable claude mcp add-json command", () => {
    const command = formatPairOutput(result, config, "claude");
    expect(command.startsWith("claude mcp add-json pwrgit '")).toBe(true);
    const json = command.slice("claude mcp add-json pwrgit ".length);
    expect(JSON.parse(json.slice(1, -1))).toEqual(config);
  });
});

describe("runPair", () => {
  it("prints config on approval and keeps the token off stderr", async () => {
    const io = recordingIo();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ agentAccess: true }), { status: 200 });
        }
        if (url.endsWith("/pair/request")) {
          return new Response(
            JSON.stringify({
              pairingId: "pair_1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              pollIntervalMs: 1
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            status: "approved",
            token: result.token,
            policyFile: result.policyFile,
            mcpUrl: result.mcpUrl,
            session: result.session
          }),
          { status: 200 }
        );
      });

    const code = await runPair(parseArgs(["pair", "--client", "Claude Code"]), io, {
      execPath: "/usr/bin/node",
      scriptPath: "/opt/pwrgit/bin.js",
      fetch: fetchMock
    });

    expect(code).toBe(0);
    expect(io.outLines.join("\n")).toContain(result.token);
    // The human channel says what happened without leaking the credential.
    expect(io.infoLines.join("\n")).not.toContain(result.token);
  });

  it("exits 3 and explains when the operator declines", async () => {
    const io = recordingIo();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ agentAccess: true }), { status: 200 });
        }
        if (url.endsWith("/pair/request")) {
          return new Response(
            JSON.stringify({
              pairingId: "pair_1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              pollIntervalMs: 1
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({ status: "denied", reason: "Nope." }),
          { status: 200 }
        );
      });

    const code = await runPair(parseArgs(["pair"]), io, {
      execPath: "/usr/bin/node",
      scriptPath: "/opt/pwrgit/bin.js",
      fetch: fetchMock
    });

    expect(code).toBe(3);
    expect(io.infoLines.join("\n")).toContain("Nope.");
    expect(io.outLines).toHaveLength(0);
  });

  it("explains that PwrGit is not running rather than reporting a fetch error", async () => {
    const io = recordingIo();
    const code = await runPair(parseArgs(["pair"]), io, {
      execPath: "/usr/bin/node",
      scriptPath: "/opt/pwrgit/bin.js",
      fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("ECONNREFUSED"))
    });

    expect(code).toBe(1);
    expect(io.infoLines.join("\n")).toMatch(/Local agent access/u);
  });
});
