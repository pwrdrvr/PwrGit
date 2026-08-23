import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpPolicyStore } from "@pwrgit/mcp-server/access-policy";
import { describe, expect, it } from "vitest";
import { CommandBus } from "../command-bus";
import { registerLocalAgentHandlers } from "./local-agent-handlers";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-agent-handlers-"));
  const policy = new McpPolicyStore(join(dir, "mcp-policy.json"));
  const bus = new CommandBus();
  let changes = 0;
  registerLocalAgentHandlers(bus, policy, () => {
    changes += 1;
  });
  return { bus, dir, changes: () => changes };
}

describe("local-agent handlers", () => {
  it("creates a one-time credential and publishes only renderer-safe policy metadata", async () => {
    const { bus, changes } = setup();
    const before = await bus.dispatch("localAgents:read", undefined);
    expect(before.ok && before.value.sessions).toHaveLength(0);

    const created = await bus.dispatch("localAgents:createSession", {
      name: "Codex",
      roleId: "builtin.discovery"
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.token).toMatch(/^pgmcp_/u);
    expect(created.value.environment.sessionTokenVariable).toBe(
      "PWRGIT_MCP_SESSION_TOKEN"
    );

    const after = await bus.dispatch("localAgents:read", undefined);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.sessions[0]).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(after.value)).not.toContain(created.value.token);
    expect(changes()).toBe(1);
  });

  it("creates scoped roles, reassigns Sessions, and revokes them", async () => {
    const { bus, dir, changes } = setup();
    const root = join(dir, "repos");
    mkdirSync(root);
    await bus.dispatch("localAgents:read", undefined);
    const role = await bus.dispatch("localAgents:roleCreate", {
      name: "Scoped",
      description: "Only one root",
      permissions: ["repository.metadata.read"],
      repositoryRoots: [root]
    });
    expect(role.ok).toBe(true);
    if (!role.ok) return;
    const session = await bus.dispatch("localAgents:createSession", {
      name: "Reader",
      roleId: "builtin.discovery"
    });
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const assigned = await bus.dispatch("localAgents:assignRole", {
      sessionId: session.value.session.id,
      roleId: role.value.id
    });
    expect(assigned.ok && assigned.value.roleId).toBe(role.value.id);
    const revoked = await bus.dispatch("localAgents:revoke", {
      id: session.value.session.id
    });
    expect(revoked.ok && revoked.value.revokedAt).not.toBeNull();
    expect(changes()).toBe(4);
  });

  it("rejects deletion while assigned to an active Session and permits it after revocation", async () => {
    const { bus, dir } = setup();
    const root = join(dir, "repos");
    mkdirSync(root);
    await bus.dispatch("localAgents:read", undefined);
    const role = await bus.dispatch("localAgents:roleCreate", {
      name: "Assigned",
      description: "",
      permissions: ["repository.roots.read"],
      repositoryRoots: [root]
    });
    if (!role.ok) throw new Error(role.error.message);
    const session = await bus.dispatch("localAgents:createSession", {
      name: "Client",
      roleId: role.value.id
    });
    if (!session.ok) throw new Error(session.error.message);

    const result = await bus.dispatch("localAgents:roleDelete", {
      id: role.value.id
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "invalid_input" }
    });

    await bus.dispatch("localAgents:revoke", { id: session.value.session.id });
    const afterRevocation = await bus.dispatch("localAgents:roleDelete", {
      id: role.value.id
    });
    expect(afterRevocation).toEqual({ ok: true, value: null });
  });
});
