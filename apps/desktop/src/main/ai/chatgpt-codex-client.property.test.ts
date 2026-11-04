import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";
import { ChatGptCodexClient } from "./chatgpt-codex-client";
import { CHATGPT_SCOPE } from "./chatgpt-auth";

type Event = { method: string; params: unknown };
class Transport implements JsonRpcTransport {
  methods: string[] = [];
  closed = false;
  private handler: (message: string) => void = () => {};
  constructor(private readonly turn: () => { id: number; status: string; early: boolean }) {}
  async connect() {}
  async close() { this.closed = true; }
  setMessageHandler(handler: (message: string) => void) { this.handler = handler; }
  setCloseHandler(_handler: (error?: Error) => void) {}
  send(raw: string) {
    const request = JSON.parse(raw) as { id?: string; method: string; params: Record<string, unknown> };
    this.methods.push(request.method);
    if (request.id === undefined) return;
    const turn = this.turn();
    let result: unknown = {};
    let events: Event[] = [];
    if (request.method === "thread/start") {
      expect(request.params).toMatchObject({ modelProvider: "openai_chatgpt_plan", dynamicTools: [], environments: [], approvalPolicy: "never", sandbox: "read-only" });
      result = { thread: { id: "thread" }, model: "fixture-model" };
    }
    if (request.method === "turn/start") {
      result = { turn: { id: `turn-${turn.id}` } };
      events = [
        // Other turns and threads must never supply this request's output or success.
        { method: "item/completed", params: { threadId: "other", turnId: `turn-${turn.id}`, item: { type: "agentMessage", text: "wrong-thread" } } },
        { method: "item/completed", params: { threadId: "thread", turnId: `turn-${turn.id - 1}`, item: { type: "agentMessage", text: "stale-turn" } } },
        { method: "turn/completed", params: { threadId: "thread", turn: { id: `turn-${turn.id - 1}`, status: "completed" } } },
        { method: "item/completed", params: { threadId: "thread", turnId: `turn-${turn.id}`, item: { type: "agentMessage", text: `answer-${turn.id}` } } },
        { method: "turn/completed", params: { threadId: "thread", turn: { id: `turn-${turn.id}`, status: turn.status } } },
      ];
    }
    const notify = () => { for (const event of events) this.handler(JSON.stringify({ jsonrpc: "2.0", ...event })); };
    queueMicrotask(() => {
      if (turn.early) notify();
      this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      if (!turn.early) queueMicrotask(notify);
    });
  }
}
it("matches the app-server lifecycle model across rotations, failures and notifications before or after turn/start replies", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    rotate: fc.boolean(), early: fc.boolean(),
    status: fc.constantFrom("completed", "failed", "interrupted"),
  }), { minLength: 1, maxLength: 12 }), async (operations) => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-siwc-model-"));
    let generation = 0;
    let turn = { id: 0, status: "completed", early: false };
    const transports: Transport[] = [];
    const env = { PWRGIT_PROFILE_ID: "work" };
    const parentToken = process.env.ACCESS_TOKEN;
    const client = new ChatGptCodexClient({
      command: "/fixture/codex", env, workspaceDir: root, version: "fixture",
      credential: async () => ({ clientId: "oaiapp_fixture", subject: "fixture", label: "fixture",
        accessToken: `access-${generation}`, refreshToken: "refresh-fixture", idToken: "id-fixture", scopes: [CHATGPT_SCOPE], expiresAt: 0 }),
      transport: (childEnv) => {
        expect(childEnv.ACCESS_TOKEN).toBe(`access-${generation}`);
        expect(env).toEqual({ PWRGIT_PROFILE_ID: "work" });
        const transport = new Transport(() => turn);
        transports.push(transport);
        return transport;
      },
    });
    // Model: failure drops the connection and thread; rotation replaces the
    // connection but resumes a healthy thread. Successful turns roll back once.
    let connected = false;
    let hasThread = false;
    try {
      for (const [index, operation] of operations.entries()) {
        const before = transports.length;
        if (operation.rotate) generation++;
        turn = { id: index, status: operation.status, early: operation.early };
        const needsConnection = !connected || operation.rotate;
        const result = await Promise.allSettled([client.run({ prompt: `fixture-${index}` })]);
        expect(transports.length).toBe(before + (needsConnection ? 1 : 0));
        const transport = transports.at(-1)!;
        if (needsConnection) {
          expect(transport.methods).toContain(hasThread ? "thread/resume" : "thread/start");
          if (before > 0) expect(transports[before - 1]!.closed).toBe(true);
        }
        const answer = result[0]!;
        expect(answer.status).toBe(operation.status === "completed" ? "fulfilled" : "rejected");
        if (answer.status === "fulfilled") expect(answer.value.rawText).toBe(`answer-${index}`);
        expect(transport.methods.filter((method) => method === "thread/rollback").length).toBe(
          transport.methods.filter((method) => method === "turn/start").length - (operation.status === "completed" ? 0 : 1));
        connected = hasThread = operation.status === "completed";
        expect(transport.closed).toBe(!connected);
        expect(process.env.ACCESS_TOKEN).toBe(parentToken);
      }
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  }));
});
