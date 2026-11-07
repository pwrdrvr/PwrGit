import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { McpPolicyStore, MCP_AGENT_CAPABILITIES } from "@pwrgit/mcp-server/access-policy";
import { CommandBus } from "../command-bus";
import { ConsentBroker } from "./consent-broker";

it("approval never authorizes a role changed after the native prompt was displayed", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom("rename", "widen", "restrict", "delete", "unchanged"), { minLength: 1, maxLength: 5 }),
    checkChanges
  ));
});

async function checkChanges(changes: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "pg-consent-"));
  try {
    const policy = new McpPolicyStore(join(directory, "policy.json")); policy.initialize();
    const role = policy.createRole({ name: "Shown", description: "", permissions: ["repository.roots.read"], repositoryRoots: null });
    const broker = new ConsentBroker(policy, () => ({ webContents: { id: 1 }, once: vi.fn(), isDestroyed: () => false, close: vi.fn() }));
    const bus = new CommandBus(); broker.register(bus);
    const abort = new AbortController();
    const decision = broker.request({ clientName: "Host", scopes: [...MCP_AGENT_CAPABILITIES], signal: abort.signal });
    const context = { webContentsId: 1, isMainFrame: true };
    const prompt = await bus.dispatch("agentAccess:consentRead", undefined, context);
    if (!prompt.ok) throw new Error(prompt.error.message);
    let changed = false;
    let removed = false;
    for (const change of changes) {
      if (removed || change === "unchanged") continue;
      changed = true;
      if (change === "delete") { policy.deleteRole(role.id); removed = true; }
      else if (change === "rename") policy.updateRole(role.id, { name: "Edited" });
      else policy.updateRole(role.id, { permissions: change === "widen" ? [...MCP_AGENT_CAPABILITIES] : ["repository.checkout.locate"] });
    }
    const result = await bus.dispatch("agentAccess:consentDecide", { requestId: prompt.value.requestId, decision: "allow", sessionName: "Host", roleId: role.id }, context);
    expect(result.ok).toBe(!changed);
    abort.abort();
    expect((await decision).decision).toBe(changed ? "deny" : "allow");
    expect(policy.snapshot().sessions).toHaveLength(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
it("a role renamed while consent is open requires a fresh prompt", () => checkChanges(["rename"]));
