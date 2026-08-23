import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MCP_AGENT_CAPABILITIES as SHARED_CAPABILITIES,
  MCP_AGENT_CAPABILITY_DETAILS as SHARED_DETAILS
} from "../../shared/src/mcp-policy.js";
import { describe, expect, it } from "vitest";
import {
  MCP_AGENT_CAPABILITIES,
  MCP_AGENT_CAPABILITY_DETAILS,
  McpAccessError,
  McpPolicyStore,
  PolicyFileAuthorizer,
  defaultMcpPolicyFile
} from "./access-policy.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-mcp-policy-"));
  const policyFile = join(root, "PwrGit", "mcp-policy.json");
  return { root, policyFile, store: new McpPolicyStore(policyFile) };
}

describe("MCP access policy", () => {
  it("keeps the server and renderer capability contracts identical", () => {
    expect(MCP_AGENT_CAPABILITIES).toEqual(SHARED_CAPABILITIES);
    expect(MCP_AGENT_CAPABILITY_DETAILS).toEqual(SHARED_DETAILS);
  });

  it("initializes canonical roles in a private file and never persists plaintext tokens", () => {
    const { policyFile, store } = fixture();
    const snapshot = store.initialize();
    const created = store.createSession("PwrAgent", "builtin.discovery");
    const contents = readFileSync(policyFile, "utf8");

    expect(snapshot.roles.map((role) => role.id)).toEqual([
      "builtin.discovery",
      "builtin.local-reader",
      "builtin.live-status"
    ]);
    expect(created.token).toMatch(/^pgmcp_[A-Za-z0-9_-]{43}$/);
    expect(contents).not.toContain(created.token);
    expect(JSON.parse(contents).sessions[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform !== "win32") {
      expect(statSync(policyFile).mode & 0o777).toBe(0o600);
    }
  });

  it("enforces capabilities, repository roots, symlink resolution, and immediate revocation", async () => {
    const { root, policyFile, store } = fixture();
    const approved = join(root, "approved");
    const repository = join(approved, "widget");
    const outside = join(root, "outside");
    mkdirSync(repository, { recursive: true });
    mkdirSync(outside);
    const outsideLink = join(approved, "outside-link");
    symlinkSync(outside, outsideLink, "dir");
    store.initialize();
    const role = store.createRole({
      name: "Scoped metadata",
      description: "One repository root, no forge access.",
      permissions: ["repository.metadata.read"],
      repositoryRoots: [approved]
    });
    const created = store.createSession("Scoped agent", role.id);
    const authorizer = new PolicyFileAuthorizer(policyFile, created.token);

    await expect(
      authorizer.authorize({
        capabilities: ["repository.metadata.read"],
        repositoryPaths: [repository]
      })
    ).resolves.toMatchObject({
      roleId: role.id,
      repositoryRoots: [realpathSync.native(approved)]
    });
    await expect(
      authorizer.authorize({ capabilities: ["forge.status.read"] })
    ).rejects.toMatchObject({ code: "missing_capability" });
    await expect(
      authorizer.authorize({
        capabilities: ["repository.metadata.read"],
        repositoryPaths: [outside]
      })
    ).rejects.toMatchObject({ code: "repository_outside_scope" });
    await expect(
      authorizer.authorize({
        capabilities: ["repository.metadata.read"],
        repositoryPaths: [outsideLink]
      })
    ).rejects.toMatchObject({ code: "repository_outside_scope" });

    store.revokeSession(created.session.id);
    await expect(authorizer.authorize()).rejects.toMatchObject({
      code: "revoked_session"
    });
  });

  it("fails closed when a built-in role is edited outside PwrGit", () => {
    const { policyFile, store } = fixture();
    store.initialize();
    const document = JSON.parse(readFileSync(policyFile, "utf8"));
    document.roles[0].permissions.push("forge.status.read");
    writeFileSync(policyFile, JSON.stringify(document), "utf8");

    expect(() => store.snapshot()).toThrowError(McpAccessError);
    expect(() => store.snapshot()).toThrow(/canonical policy/u);
  });

  it("resolves the same platform policy locations used by Electron userData", () => {
    expect(defaultMcpPolicyFile({}, "darwin", "/Users/test")).toBe(
      "/Users/test/Library/Application Support/PwrGit/mcp-policy.json"
    );
    expect(defaultMcpPolicyFile({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/test")).toBe(
      "/cfg/PwrGit/mcp-policy.json"
    );
    expect(defaultMcpPolicyFile({ APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "win32", "C:\\Users\\test")).toContain(
      "PwrGit"
    );
  });
});
