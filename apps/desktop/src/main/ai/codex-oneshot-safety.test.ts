import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexOneShotClient } from "@pwrdrvr/agent-client";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

type Envelope = {
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
};

class FakeTransport {
  readonly sent: Envelope[] = [];
  private messageHandler: (message: string) => void = () => undefined;
  private turn = 0;

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }
  setCloseHandler(handler: (error?: Error) => void): void {
    void handler;
  }

  send(message: string): void {
    const envelope = JSON.parse(message) as Envelope;
    this.sent.push(envelope);
    if (envelope.id === undefined || envelope.method === undefined) return;
    const result = this.responseFor(envelope.method);
    queueMicrotask(() => {
      this.messageHandler(
        JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result })
      );
    });
  }

  notify(method: string, params: unknown): void {
    this.messageHandler(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  request(method: string, params: unknown): string {
    const id = `server-${this.sent.length + 1}`;
    this.messageHandler(
      JSON.stringify({ jsonrpc: "2.0", id, method, params })
    );
    return id;
  }

  private responseFor(method: string): unknown {
    switch (method) {
      case "initialize":
        return { userAgent: "fake-codex/1.0", capabilities: {} };
      case "thread/start":
        return {
          thread: { id: "thread-1" },
          model: "gpt-5",
          modelProvider: "openai",
          serviceTier: null
        };
      case "turn/start":
        this.turn += 1;
        return { turn: { id: `turn-${this.turn}` } };
      default:
        return {};
    }
  }
}

describe("Codex one-shot rebase safety posture", () => {
  it("opens outside the repo with no exec environment or tools and rejects tool calls", async () => {
    const transport = new FakeTransport();
    const root = mkdtempSync(join(tmpdir(), "pwrgit-agent-safety-"));
    tempRoots.push(root);
    const workspaceDir = join(root, "pwrgit-agent", "work");
    const client = new CodexOneShotClient({
      workspaceDir,
      transportFactory: () => transport,
      requestTimeoutMs: 1_000,
      turnTimeoutMs: 1_000
    });

    const pending = client.run({
      prompt: "review metadata only",
      outputSchema: { type: "object" },
      baseInstructions: "Never use tools."
    });
    await vi.waitFor(() =>
      expect(transport.sent.some((entry) => entry.method === "turn/start")).toBe(
        true
      )
    );

    const threadStart = transport.sent.find(
      (entry) => entry.method === "thread/start"
    )?.params as Record<string, unknown>;
    expect(threadStart).toEqual(
      expect.objectContaining({
        cwd: workspaceDir,
        runtimeWorkspaceRoots: [workspaceDir],
        approvalPolicy: "never",
        sandbox: "read-only",
        environments: []
      })
    );
    expect(threadStart["cwd"]).not.toBe("/repo");
    expect(threadStart["dynamicTools"]).toBeUndefined();

    const serverRequestId = transport.request("item/tool/call", {
      tool: "git reset --hard"
    });
    await vi.waitFor(() =>
      expect(
        transport.sent.some(
          (entry) => entry.id === serverRequestId && entry.result !== undefined
        )
      ).toBe(true)
    );
    const denied = transport.sent.find(
      (entry) => entry.id === serverRequestId
    )?.result as { success?: boolean; contentItems?: unknown[] };
    expect(denied.success).toBe(false);
    expect(denied.contentItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("does not expose tools")
        })
      ])
    );

    transport.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "message-1", type: "agentMessage", text: "{}" }
    });
    transport.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null }
    });
    await expect(pending).resolves.toEqual(
      expect.objectContaining({ rawText: "{}", threadId: "thread-1" })
    );
    await client.close();
  });
});
