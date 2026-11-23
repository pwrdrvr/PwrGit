import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { McpPolicyStore, type McpAgentCapability, type McpPolicyFile } from "./access-policy.js";

const legacyLiveStatus = [
  "repository.roots.read", "repository.checkout.locate", "repository.metadata.read",
  "forge.status.read", "status.subscribe"
] as const satisfies readonly McpAgentCapability[];

it("keeps the effective grants of v0.61.3 policies across startup and subsequent writes", () => {
  fc.assert(fc.property(
    fc.boolean(),
    fc.constantFrom("legacy", "native", "oauth"),
    fc.subarray<McpAgentCapability>([...legacyLiveStatus, "app.navigate"], { minLength: 1 }),
    (liveStatus, sessionKind, scope) => {
      const directory = mkdtempSync(join(tmpdir(), "pg-policy-upgrade-"));
      try {
        const path = join(directory, "mcp-policy.json");
        const store = new McpPolicyStore(path);
        store.initialize();
        const roleId = liveStatus ? "builtin.live-status" : "builtin.app-operator";
        const issued = store.createSession(
          "Existing client",
          roleId,
          sessionKind === "oauth" ? { clientId: "fixture", scopes: scope } : undefined,
          sessionKind === "native" ? { permissions: scope, repositoryRoots: null } : undefined
        );
        const oldPolicy = JSON.parse(readFileSync(path, "utf8")) as McpPolicyFile;
        // The v0.61.3 definitions are independent of the current built-in registry.
        oldPolicy.roles.find(role => role.id === "builtin.live-status")!.permissions = [...legacyLiveStatus];
        oldPolicy.roles.find(role => role.id === "builtin.app-operator")!.permissions = [...legacyLiveStatus, "app.navigate"];
        const priorPermissions = oldPolicy.roles.find(role => role.id === roleId)!.permissions;
        const expected = priorPermissions.filter(permission => sessionKind === "legacy" || scope.includes(permission));
        const oldContents = JSON.stringify(oldPolicy);
        writeFileSync(path, oldContents);

        const upgraded = new McpPolicyStore(path);
        expect(upgraded.initialize().roles).toEqual(oldPolicy.roles);
        expect(readFileSync(path, "utf8")).toBe(oldContents);
        expect(upgraded.authorize(issued.token).capabilities).toEqual(expected);
        const reconnected = upgraded.createNativeSession("Reconnected client", roleId);
        const reopened = new McpPolicyStore(path);
        expect(reopened.authorize(issued.token).capabilities).toEqual(expected);
        expect(reopened.authorize(reconnected.token).capabilities).toEqual(priorPermissions);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  ), { numRuns: 25 });
});
