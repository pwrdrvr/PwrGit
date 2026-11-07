// @vitest-environment jsdom
import fc from "fast-check";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ok, MCP_AGENT_CAPABILITY_DETAILS } from "@pwrgit/shared";
import { MCP_AGENT_CAPABILITIES, McpPolicyStore, type McpAgentCapability } from "@pwrgit/mcp-server/access-policy";
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn(() => () => undefined) }));
vi.mock("../../lib/pwrgit", () => mocks);
import { LocalAgentsSettings } from "./LocalAgentsSettings";

it("the displayed native Session permissions agree with the policy after arbitrary role edits", async () => {
  await fc.assert(fc.asyncProperty(
    fc.subarray([...MCP_AGENT_CAPABILITIES], { minLength: 1 }),
    fc.subarray([...MCP_AGENT_CAPABILITIES], { minLength: 1 }),
    checkGraphPermissions
  ));
});

async function checkGraphPermissions(approved: McpAgentCapability[], current: McpAgentCapability[]) {
  const directory = mkdtempSync(join(tmpdir(), "pg-graph-"));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    const policy = new McpPolicyStore(join(directory, "policy.json")); policy.initialize();
    const role = policy.createRole({ name: "Role", description: "", permissions: approved, repositoryRoots: null });
    const issued = policy.createNativeSession("Host", role.id);
    policy.updateRole(role.id, { permissions: current });
    mocks.dispatch.mockImplementation((command: string) => Promise.resolve(ok(command === "localAgents:read" ? policy.snapshot() : { enabled: false, listening: false, mcpUrl: "", executable: "/fixture/pwrgit-mcp", platform: "darwin" })));
    await act(async () => { root.render(<LocalAgentsSettings />); });
    const labels = [...container.querySelectorAll(".agent-auth-permission.is-allowed b")].map(element => element.textContent);
    expect(labels).toEqual(policy.authorize(issued.token).capabilities.map(capability => MCP_AGENT_CAPABILITY_DETAILS[capability].label));
    expect(container.textContent).toContain("Native consent ceiling");
  } finally {
    await act(async () => root.unmount()); container.remove();
    rmSync(directory, { recursive: true, force: true });
  }
}
it("metadata permission stays denied when only root discovery was approved", () => checkGraphPermissions(["repository.roots.read"], ["repository.metadata.read"]));
