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
  return { bus, dir, policy, changes: () => changes };
}

describe("local-agent handlers", () => {
  it("rejects manual Session minting", async () => {
    const { bus } = setup();
    expect(await bus.dispatch("localAgents:createSession" as never, { name: "Client", roleId: "builtin.discovery" } as never))
      .toMatchObject({ ok: false, error: { code: "no_handler" } });
  });

  it("creates scoped roles, reassigns Sessions, and revokes them", async () => {
    const { bus, dir, policy, changes } = setup();
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
    const session = { ok: true, value: policy.createSession("Reader", "builtin.discovery") };
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
    expect(changes()).toBe(3);
  });

  it("rejects deletion while assigned to an active Session and permits it after revocation", async () => {
    const { bus, dir, policy } = setup();
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
    const session = { ok: true, value: policy.createSession("Client", role.value.id) };


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
