import fc from "fast-check";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StackResources } from "./stack-tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, test, vi } from "vitest";
import { FixedMcpAuthorizer, fullAccessAuthorization } from "./access-policy.js";
import { createPwrGitMcpServer } from "./server.js";
import type { AppBackend } from "./app-tools.js";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("stack resources update on change and enforce repository and subscription grants", async () => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-stack-tools-"));
  const inside = join(root, "inside");
  const outside = join(root, "outside");
  mkdirSync(inside);
  mkdirSync(outside);
  const repo = (id: string, path: string) => ({ id, path, name: id, profileId: "profile", pinned: false, worktrees: [] });
  let id = "first";
  const backend: AppBackend = {
    catalog: () => ({ activeProfileId: "profile", profiles: [], repositories: [repo("inside", inside), repo("outside", outside)] }),
    open: vi.fn(), refresh: vi.fn(),
    stackList: vi.fn(async () => ({ schemaVersion: 1, readOnly: false, stacks: [{ id }] })),
  };
  const auth = new FixedMcpAuthorizer({
    ...fullAccessAuthorization(), capabilities: ["repository.stack.read", "status.subscribe"], repositoryRoots: [realpathSync(inside)],
  });
  const server = await createPwrGitMcpServer({ appBackend: backend, authorizer: auth });
  const client = new Client({ name: "stacks-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.find(tool => tool.name === "pwrgit_stack_list")?.annotations?.readOnlyHint).toBe(true);
    expect((await client.callTool({ name: "pwrgit_stack_list", arguments: { repoId: "outside" } })).isError).toBe(true);
    expect(backend.stackList).not.toHaveBeenCalled();
    const listed = await client.callTool({ name: "pwrgit_stack_list", arguments: { repoId: "inside" } });
    expect(listed.isError, JSON.stringify(listed)).not.toBe(true);
    const uri = (listed.structuredContent as { resourceUri: string }).resourceUri;
    expect(uri.endsWith("/stacks")).toBe(true);
    expect((await client.callTool({ name: "pwrgit_stack_get", arguments: { repoId: "inside", stackId: "first" } })).structuredContent)
      .toMatchObject({ stack: { id: "first" } });
    expect(await client.readResource({ uri })).toMatchObject({ contents: [{ uri }] });
    await expect(client.readResource({ uri: "pwrgit://repository/outside/stacks" })).rejects.toThrow();

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const updates = vi.fn();
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, updates);
    await client.subscribeResource({ uri });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(updates).not.toHaveBeenCalled();
    id = "second";
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(updates).toHaveBeenCalledTimes(1));
    await client.unsubscribeResource({ uri });
    id = "third";
    await vi.advanceTimersByTimeAsync(15_000);
    expect(updates).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsubscribe or close during the initial read cannot start a ghost poll", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (close, resubscribe) => {
      type Snapshot = Awaited<ReturnType<NonNullable<AppBackend["stackList"]>>>;
      const empty: Snapshot = { schemaVersion: 1, readOnly: false, stacks: [] };
      let finishInitial!: (snapshot: Snapshot) => void;
      let markBegan!: () => void;
      const initial = new Promise<Snapshot>(resolve => { finishInitial = resolve; });
      const began = new Promise<void>(resolve => { markBegan = resolve; });
      const stackList = vi.fn(async () => empty).mockImplementationOnce(() => {
        markBegan();
        return initial;
      });
      const mcp = new McpServer({ name: "stack-model", version: "1" });
      const resources = new StackResources(mcp, {
        catalog: () => ({ activeProfileId: "profile", profiles: [], repositories: [
          { id: "orbit", path: tmpdir(), name: "Orbit", profileId: "profile", pinned: false, worktrees: [] },
        ] }), open: vi.fn(), refresh: vi.fn(), stackList,
      }, new FixedMcpAuthorizer(fullAccessAuthorization()), true);
      const uri = "pwrgit://repository/orbit/stacks";
      try {
        const subscription = resources.subscribe(uri);
        await began;
        if (close) resources.close();
        else resources.unsubscribe(uri);
        if (resubscribe) await resources.subscribe(uri);
        finishInitial({ ...empty, stacks: [{ id: "obsolete" }] });
        await subscription;
        expect(vi.getTimerCount()).toBe(resubscribe ? 1 : 0);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(stackList).toHaveBeenCalledTimes(resubscribe ? 3 : 1);
      } finally {
        resources.close();
      }
    }), { numRuns: 12 });
  } finally {
    vi.useRealTimers();
  }
});
