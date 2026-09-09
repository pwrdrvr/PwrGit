import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundledCliLaunch,
  bundledCliMcpConfig,
  resolveBundledCliPath
} from "./bundled-cli";

describe("resolveBundledCliPath", () => {
  const resourcesPath = resolve("fixture", "PwrGit", "resources");
  const repoRoot = resolve("fixture", "repo");
  const appPath = join(repoRoot, "apps", "desktop");
  it("prefers the packaged resources copy", () => {
    const path = resolveBundledCliPath({
      resourcesPath,
      packaged: true,
      exists: () => true
    });
    expect(path).toBe(
      join(resourcesPath, "pwrgit-mcp.mjs")
    );
  });

  it("falls back to the workspace build during development", () => {
    const path = resolveBundledCliPath({
      resourcesPath,
      packaged: false,
      appPath,
      exists: (candidate) => candidate.includes("dist-bundle")
    });
    expect(path).toBe(join(repoRoot, "packages", "mcp-server", "dist-bundle", "pwrgit-mcp.mjs"));
  });

  it("never falls back to the workspace path in a packaged build", () => {
    // A packaged app has no repository beside it; guessing one would hand out
    // a config whose script does not exist.
    const path = resolveBundledCliPath({
      resourcesPath,
      packaged: true,
      appPath: join(resourcesPath, "app.asar"),
      exists: (candidate) => candidate.includes("dist-bundle")
    });
    expect(path).toBeUndefined();
  });

  it("returns undefined rather than a guess when nothing is built", () => {
    expect(
      resolveBundledCliPath({
        resourcesPath,
        packaged: false,
        appPath,
        exists: () => false
      })
    ).toBeUndefined();
  });
});

describe("bundledCliLaunch", () => {
  it("runs the app's own binary as node so no Node install is needed", () => {
    const launch = bundledCliLaunch({
      execPath: "/Applications/PwrGit.app/Contents/MacOS/PwrGit",
      scriptPath: "/Applications/PwrGit.app/Contents/Resources/pwrgit-mcp.mjs",
      policyFile: "/Users/me/policy.json"
    });
    expect(launch.command).toBe("/Applications/PwrGit.app/Contents/MacOS/PwrGit");
    expect(launch.args).toEqual([
      "/Applications/PwrGit.app/Contents/Resources/pwrgit-mcp.mjs",
      "serve"
    ]);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
    // The token is supplied per client and never baked into the launch.
    expect(launch.env).not.toHaveProperty("PWRGIT_MCP_SESSION_TOKEN");
  });

  it("produces a config carrying the caller's token", () => {
    const launch = bundledCliLaunch({
      execPath: "/bin/pwrgit",
      scriptPath: "/res/pwrgit-mcp.mjs",
      policyFile: "/policy.json"
    });
    const parsed = JSON.parse(bundledCliMcpConfig(launch, "pgmcp_abc")) as {
      mcpServers: { pwrgit: { env: Record<string, string> } };
    };
    expect(parsed.mcpServers.pwrgit.env).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      PWRGIT_MCP_POLICY_FILE: "/policy.json",
      PWRGIT_MCP_SESSION_TOKEN: "pgmcp_abc"
    });
  });
});
