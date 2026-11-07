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
