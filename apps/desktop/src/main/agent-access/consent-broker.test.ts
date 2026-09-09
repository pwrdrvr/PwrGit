import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { McpPolicyStore, MCP_AGENT_CAPABILITIES } from "@pwrgit/mcp-server/access-policy";
import { CommandBus } from "../command-bus";
import { ConsentBroker } from "./consent-broker";
it("only accepts a decision from the exact consent window's main frame", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-consent-"));
  try {
    const policy = new McpPolicyStore(join(dir, "policy.json")); policy.initialize();
    const close = vi.fn();
    const broker = new ConsentBroker(policy, () => ({ webContents: { id: 41 }, once: vi.fn(), close }));
    const bus = new CommandBus(); broker.register(bus);
    const abort = new AbortController();
    const decision = broker.request({ clientName: "Client", scopes: [...MCP_AGENT_CAPABILITIES], signal: abort.signal });
    const trusted = { webContentsId: 41, isMainFrame: true };
    for (const context of [{}, { webContentsId: 42, isMainFrame: true }, { webContentsId: 41, isMainFrame: false }]) {
      expect((await bus.dispatch("agentAccess:consentRead", undefined, context)).ok).toBe(false);
    }
    const read = await bus.dispatch("agentAccess:consentRead", undefined, trusted);
    if (!read.ok) throw new Error(read.error.message);
    const approve = { requestId: read.value.requestId, decision: "allow" as const, sessionName: "Approved agent", roleId: "builtin.local-reader" };
    expect((await bus.dispatch("agentAccess:consentDecide", approve, { webContentsId: 42, isMainFrame: true })).ok).toBe(false);
    expect((await bus.dispatch("agentAccess:consentDecide", { ...approve, requestId: "forged" }, trusted)).ok).toBe(false);
    expect((await bus.dispatch("agentAccess:consentDecide", approve, trusted)).ok).toBe(true);
    expect(await decision).toEqual(approve);
    expect(close).toHaveBeenCalledTimes(1);
    expect((await bus.dispatch("agentAccess:consentDecide", approve, trusted)).ok).toBe(false);
    expect(policy.snapshot().sessions).toHaveLength(0); // Token exchange owns minting.
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("limits roles to requested scopes and denies when authorization is aborted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-consent-"));
  try {
    const policy = new McpPolicyStore(join(dir, "policy.json")); policy.initialize();
    const broker = new ConsentBroker(policy, () => ({ webContents: { id: 1 }, once: vi.fn(), close: vi.fn() }));
    const bus = new CommandBus(); broker.register(bus);
    const abort = new AbortController();
    const decision = broker.request({ clientName: "Reader", scopes: ["repository.roots.read", "repository.checkout.locate"], signal: abort.signal });
    const read = await bus.dispatch("agentAccess:consentRead", undefined, { webContentsId: 1, isMainFrame: true });
    expect(read.ok && read.value.roles.map(r => r.id)).toEqual(["builtin.discovery"]);
    abort.abort();
    expect((await decision).decision).toBe("deny");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
