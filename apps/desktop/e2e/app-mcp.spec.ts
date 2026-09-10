import { dirname, join, normalize } from "node:path";
import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpPolicyStore, MCP_AGENT_CAPABILITIES } from "@pwrgit/mcp-server/access-policy";
import { launchApp } from "./fixtures/electron-app";
import { createGitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, branchRow } from "./fixtures/steps";

test("HTTP MCP answers recent repos from the app and opens and refreshes real worktrees", async () => {
  const sandbox = createGitSandbox();
  const zeta = sandbox.makeRepo("zeta");
  const alpha = sandbox.makeRepo("alpha");
  const handle = await launchApp({ agentAccess: true });
  const client = new Client({ name: "app-integration", version: "1" });
  try {
    await addRootAndExpand(handle.window, handle, sandbox, "zeta");
    await branchRow(handle.window, "main").first().click();
    const userData = await handle.app.evaluate(({ app }) => app.getPath("userData"));
    // Seed a contrived authorized OAuth Session in the isolated fixture policy.
    // OAuth/PKCE/native-consent behavior is covered by the HTTP auth suite.
    const policy = new McpPolicyStore(join(userData, "mcp-policy.json"));
    policy.initialize();
    const role = policy.createRole({ name: "Fixture app control", description: "", permissions: [...MCP_AGENT_CAPABILITIES], repositoryRoots: [sandbox.reposDir, join(dirname(sandbox.reposDir), "worktrees")] });
    const { token } = policy.createSession("fixture", role.id, { clientId: "fixture", scopes: [...MCP_AGENT_CAPABILITIES] });
    const enabled = await handle.window.evaluate(async () => window.pwrgit.dispatch("agentAccess:setEnabled", { enabled: true })) as { ok: boolean; value: { listening: boolean; mcpUrl: string } };
    expect(enabled.ok).toBe(true); expect(enabled.value.listening).toBe(true);
    await client.connect(new StreamableHTTPClientTransport(new URL(enabled.value.mcpUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as unknown as Parameters<typeof client.connect>[0]);
    const list = async () => {
      const response = await client.callTool({ name: "pwrgit_app_repositories", arguments: {} });
      expect(response.isError).not.toBe(true);
      return response.structuredContent as { repositories: Array<{ id: string; name: string; path: string; lastViewedAt: string | null; worktrees: Array<{ id: string; path: string }> }> };
    };
    await expect.poll(async () => (await list()).repositories[0]?.name).toBe("zeta");
    const recent = await list();
    // Git uses forward slashes on Windows; compare native-normalized paths.
    expect(normalize(recent.repositories[0]!.path)).toBe(normalize(zeta.path));
    expect(recent.repositories[0]!.lastViewedAt).not.toBeNull();
    const other = recent.repositories.find(repo => repo.name === "alpha")!;
    expect((await client.callTool({ name: "pwrgit_app_open", arguments: { repoId: other.id, worktreeId: other.worktrees[0]!.id } })).isError).not.toBe(true);
    await expect.poll(async () => (await list()).repositories[0]?.name).toBe("alpha");
    const external = alpha.addWorktree("external");
    expect((await client.callTool({ name: "pwrgit_app_refresh", arguments: { repoId: other.id } })).isError).not.toBe(true);
    await expect.poll(async () => (await list()).repositories.find(repo => repo.id === other.id)?.worktrees.map(w => normalize(w.path))).toContain(normalize(external));
    const roots = await client.callTool({ name: "pwrgit_repository_roots", arguments: {} });
    const discovered = roots.structuredContent as { roots: Array<{ path: string }> };
    expect(discovered.roots.map(root => normalize(root.path))).toContain(normalize(sandbox.reposDir));
    expect(JSON.stringify(roots.structuredContent)).not.toContain("current_workspace");
  } finally { await client.close(); await handle.cleanup(); sandbox.cleanup(); }
});
