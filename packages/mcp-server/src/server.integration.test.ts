import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY_RESOURCE_URI, createPwrGitMcpServer } from "./server.js";
import {
  STATUS_RESOURCE_PROTOCOL,
  type StatusResourceDocument
} from "./status-resources.js";
import type { LiveStatusSnapshot } from "./types.js";
import {
  FixedMcpAuthorizer,
  McpAccessError,
  fullAccessAuthorization,
  type McpAuthorizer
} from "./access-policy.js";

function snapshot(ciState: LiveStatusSnapshot["ci"]["state"]): LiveStatusSnapshot {
  return {
    observedAt: new Date().toISOString(),
    repositoryPath: resolve("/tmp/pwrgit-mcp-integration"),
    identity: { provider: "github", host: "github.com", path: "acme/widget" },
    local: {
      branch: "feature/live",
      upstream: "origin/feature/live",
      ahead: 1,
      behind: 0,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      conflictedFiles: 0,
      changedFiles: 0,
      clean: true,
      operation: null
    },
    changeRequest: {
      provider: "github",
      host: "github.com",
      repository: "acme/widget",
      number: 12,
      url: "https://github.com/acme/widget/pull/12",
      state: "open",
      draft: false,
      sourceBranch: "feature/live",
      targetBranch: "main"
    },
    ci: {
      state: ciState,
      total: 1,
      succeeded: ciState === "success" ? 1 : 0,
      failed: ciState === "terminal_failure" ? 1 : 0,
      running: ciState === "running" ? 1 : 0,
      pending: 0,
      skipped: 0
    },
    mergeConflict: false,
    reviews: {
      decision: "none",
      blocking: false,
      blockingReason: null,
      latest: []
    },
    providerAvailable: true
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PwrGit MCP integration", () => {
  it("negotiates subscriptions and notifies clients to re-read status resources", async () => {
    let ciState: LiveStatusSnapshot["ci"]["state"] = "running";
    const server = await createPwrGitMcpServer({
      liveStatusLoader: async () => snapshot(ciState),
      authorizer: new FixedMcpAuthorizer(fullAccessAuthorization())
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.mcp.connect(serverTransport);
    const client = new Client(
      { name: "pwrgit-test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    const updatedUris: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updatedUris.push(notification.params.uri);
    });
    await client.connect(clientTransport);

    try {
      expect(client.getServerCapabilities()?.resources).toMatchObject({
        listChanged: true,
        subscribe: true
      });
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "pwrgit_repository_roots",
          "pwrgit_find_checkout",
          "pwrgit_repository_info",
          "pwrgit_watch_repository",
          "pwrgit_live_status_capabilities"
        ])
      );
      expect(
        tools.tools.find((tool) => tool.name === "pwrgit_watch_repository")
          ?.annotations
      ).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      });

      const capabilities = await client.readResource({ uri: CAPABILITY_RESOURCE_URI });
      const capabilityContent = capabilities.contents[0];
      const capabilityText =
        capabilityContent !== undefined && "text" in capabilityContent
          ? capabilityContent.text
          : undefined;
      expect(capabilityText).toBeTypeOf("string");
      expect(JSON.parse(capabilityText!) as unknown).toMatchObject({
        authorization: {
          protocol: "pwrgit.mcp-policy/v1",
          required: true,
          sessionId: "session_test",
          roleId: "builtin.live-status"
        },
        mcp: {
          primary: "subscribable_status_resource",
          resourceSubscriptions: { supported: true }
        },
        websocket: { subprotocol: "pwrgit.events.v1" }
      });

      const watched = await client.callTool({
        name: "pwrgit_watch_repository",
        arguments: {
          path: resolve("/tmp/pwrgit-mcp-integration"),
          intervalMs: 5_000
        }
      });
      const document = watched.structuredContent as unknown as StatusResourceDocument;
      expect(document.protocol).toBe(STATUS_RESOURCE_PROTOCOL);
      expect(document.snapshot.ci.state).toBe("running");

      vi.useFakeTimers();
      await client.subscribeResource({ uri: document.resourceUri });
      ciState = "success";
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(updatedUris).toContain(document.resourceUri));

      const refreshed = await client.readResource({ uri: document.resourceUri });
      const refreshedContent = refreshed.contents[0];
      if (refreshedContent === undefined || !("text" in refreshedContent)) {
        throw new Error("expected text status resource");
      }
      const refreshedDocument = JSON.parse(
        refreshedContent.text
      ) as StatusResourceDocument;
      expect(refreshedDocument.snapshot.ci.state).toBe("success");
      await client.unsubscribeResource({ uri: document.resourceUri });
    } finally {
      vi.useRealTimers();
      await client.close();
      await server.close();
    }
  });

  it("revalidates a revoked Session before standard MCP subscriptions", async () => {
    const authorization = fullAccessAuthorization();
    let active = true;
    let loads = 0;
    const authorizer: McpAuthorizer = {
      authorize: async () => {
        if (!active) throw new McpAccessError("revoked_session", "revoked");
        return authorization;
      }
    };
    const server = await createPwrGitMcpServer({
      authorizer,
      liveStatusLoader: async () => {
        loads += 1;
        return snapshot("running");
      }
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.mcp.connect(serverTransport);
    const client = new Client(
      { name: "pwrgit-revocation-test", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);

    try {
      const watched = await client.callTool({
        name: "pwrgit_watch_repository",
        arguments: { path: resolve("/tmp/pwrgit-mcp-integration") }
      });
      const document = watched.structuredContent as unknown as StatusResourceDocument;
      expect(loads).toBe(1);
      active = false;
      await expect(
        client.subscribeResource({ uri: document.resourceUri })
      ).rejects.toThrow(/revoked/u);
      expect(loads).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("limits discovery to the roots assigned to the Session role", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-scoped-discovery-"));
    mkdirSync(join(root, ".git"));
    const authorization = {
      sessionId: "session_scoped",
      sessionName: "Scoped discovery",
      roleId: "role_scoped",
      roleName: "One root",
      capabilities: ["repository.roots.read"] as const,
      repositoryRoots: [root]
    };
    const server = await createPwrGitMcpServer({
      authorizer: new FixedMcpAuthorizer(authorization),
      liveStatusLoader: async () => snapshot("none")
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.mcp.connect(serverTransport);
    const client = new Client(
      { name: "pwrgit-scope-test", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "pwrgit_repository_roots",
        arguments: {}
      });
      expect(result.structuredContent).toMatchObject({
        roots: [{ path: realpathSync.native(root), source: "requested" }]
      });
      const denied = await client.callTool({
        name: "pwrgit_repository_info",
        arguments: { path: root }
      });
      expect(denied).toMatchObject({ isError: true });
      expect(denied.content).toContainEqual(
        expect.objectContaining({
          type: "text",
          text: expect.stringMatching(/repository\.metadata\.read/u)
        })
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
