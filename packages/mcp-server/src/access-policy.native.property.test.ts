import fc from "fast-check";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MCP_AGENT_CAPABILITIES, McpPolicyStore, type McpAgentCapability } from "./access-policy.js";

it("native consent is a persisted ceiling across arbitrary role edits and reassignment", () => {
  fc.assert(fc.property(
    fc.subarray([...MCP_AGENT_CAPABILITIES], { minLength: 1 }),
    fc.subarray([...MCP_AGENT_CAPABILITIES], { minLength: 1 }),
    fc.boolean(), fc.boolean(),
    checkNativeCeiling
  ));
});

function checkNativeCeiling(approved: McpAgentCapability[], current: McpAgentCapability[], edit: boolean, widenRoots: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "pg-ceiling-"));
  try {
    const root = realpathSync.native(directory);
    const allowed = join(root, "allowed"); const outside = join(root, "outside");
    mkdirSync(allowed); mkdirSync(outside);
    const path = join(root, "policy.json");
    let policy = new McpPolicyStore(path); policy.initialize();
    const role = policy.createRole({ name: "Native", description: "", permissions: approved, repositoryRoots: [allowed] });
    const issued = policy.createNativeSession("Approved", role.id);
    if (edit) policy.updateRole(role.id, { permissions: current, repositoryRoots: widenRoots ? null : [outside] });
    else {
      const replacement = policy.createRole({ name: "Replacement", description: "", permissions: current, repositoryRoots: widenRoots ? null : [outside] });
      policy.assignRole(issued.session.id, replacement.id);
    }
    policy = new McpPolicyStore(path); // Reopen, rather than rely on an in-memory snapshot.
    expect(policy.authorize(issued.token).capabilities).toEqual(current.filter(value => approved.includes(value)));
    expect(() => policy.authorize(issued.token, { repositoryPaths: [outside] })).toThrow("outside");
    if (widenRoots) expect(() => policy.authorize(issued.token, { repositoryPaths: [allowed] })).not.toThrow();
    else expect(() => policy.authorize(issued.token, { repositoryPaths: [allowed] })).toThrow("outside");
    policy.revokeSession(issued.session.id);
    expect(() => policy.authorize(issued.token)).toThrow("revoked");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
it("reassignment cannot exchange an approved root for an unrelated root", () => checkNativeCeiling(["app.navigate"], ["app.navigate"], false, false));

it("revoked Sessions never block a new one: only active Sessions count toward the limit", () => {
  // Each relay connection is a Session revoked when it disconnects. Against a
  // model of the active set, opening must succeed below 256 active Sessions,
  // and an active Session must never be dropped to make room.
  fc.assert(fc.property(
    fc.array(fc.oneof(fc.constant("open" as const), fc.constant("close" as const)), { minLength: 260, maxLength: 600 }),
    (operations) => {
      const directory = mkdtempSync(join(tmpdir(), "pg-limit-"));
      try {
        const policy = new McpPolicyStore(join(directory, "policy.json")); policy.initialize();
        const active: string[] = [];
        for (const operation of operations) {
          if (operation === "close" && active.length > 0) {
            policy.revokeSession(active.shift()!);
            continue;
          }
          if (active.length >= 256) {
            expect(() => policy.createNativeSession("Host", "builtin.discovery")).toThrow(/session limit/);
            continue;
          }
          active.push(policy.createNativeSession("Host", "builtin.discovery").session.id);
        }
        const live = policy.snapshot().sessions.filter(session => session.revokedAt === null).map(session => session.id);
        expect(live.sort()).toEqual([...active].sort());
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  ), { numRuns: 15 });
});
