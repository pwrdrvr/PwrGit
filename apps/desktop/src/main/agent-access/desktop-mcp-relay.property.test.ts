import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PwrGitMcpServer } from "@pwrgit/mcp-server";
import { McpPolicyStore } from "@pwrgit/mcp-server/access-policy";
import { MCP_RELAY_PATH, MCP_RELAY_PROTOCOL } from "@pwrgit/mcp-server/agent-access-protocol";
import { expect, it, vi } from "vitest";
import { DesktopMcpRelay } from "./desktop-mcp-relay";

// The model controls OS delivery and backend construction/cleanup, not the
// relay's admission logic or SDK stdio parser. The integration suite separately
// exercises real WebSockets, HTTP and the full desktop server factory.
class ByteStream extends EventEmitter {
  destroyed = false;
  pause() { return this; }
  write() { return true; }
  destroy() { this.destroyed = true; return this; }
}
class Peer extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly stream = new ByteStream();
  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  close() { this.terminate(); }
}
class Upgrade {
  destroyed = false;
  status: number | undefined;
  readonly peer = new Peer();
  end(response: string) { this.status = Number(response.split(" ")[1]); }
  destroy() { this.destroyed = true; this.peer.terminate(); }
}
vi.mock("ws", () => ({
  WebSocketServer: class extends EventEmitter {
    handleUpgrade(_req: unknown, socket: Upgrade, _head: Buffer, connected: (peer: Peer) => void) {
      socket.status = 101;
      connected(socket.peer);
    }
    close(callback: () => void) { callback(); }
  },
  createWebSocketStream: (peer: Peer) => peer.stream
}));

type Model = { valid: boolean[]; peers: Map<number, number>; stopped: boolean; calls: number };
class Desktop {
  readonly http = new EventEmitter() as HttpServer;
  readonly dir = mkdtempSync(join(tmpdir(), "pwrgit-relay-model-"));
  readonly policy = new McpPolicyStore(join(this.dir, "policy.json"));
  readonly credentials: Array<ReturnType<McpPolicyStore["createSession"]>> = [];
  readonly upgrades: Upgrade[] = [];
  liveServers = 0;
  peakServers = 0;
  calls = 0;
  relay: DesktopMcpRelay;
  constructor(readonly scheduler: fc.Scheduler) {
    this.policy.initialize();
    for (let index = 0; index < 3; index++) this.issue();
    this.relay = this.start();
  }
  issue() { this.credentials.push(this.policy.createSession("Model " + this.credentials.length, "builtin.discovery")); }
  start() {
    return new DesktopMcpRelay({ http: this.http, policyFile: this.policy.filePath, desktopVersion: "model",
      authority: () => "127.0.0.1:1", allowedOrigin: origin => origin === undefined,
      createServer: async () => {
        this.liveServers++;
        this.peakServers = Math.max(this.peakServers, this.liveServers);
        const mcp = new McpServer({ name: "desktop-model-backend", version: "1" });
        mcp.registerTool("probe", { inputSchema: {} }, () => { this.calls++; return { content: [] }; });
        let closing: Promise<void> | undefined;
        const server = { mcp, close: () => closing ??= this.scheduler.schedule(Promise.resolve(), "backend cleanup").then(async () => {
          await mcp.close(); this.liveServers--;
        }) };
        // Only the factory seam is substituted. DesktopMcpRelay uses the same
        // mcp.connect/close surface as the real factory; no registry is mocked.
        await this.scheduler.schedule(Promise.resolve(), "backend construction");
        return server as PwrGitMcpServer;
      }
    });
  }
  connect(session: number) {
    const upgrade = new Upgrade();
    const id = this.upgrades.push(upgrade) - 1;
    this.http.emit("upgrade", { url: MCP_RELAY_PATH, headers: {
      host: "127.0.0.1:1", "sec-websocket-protocol": MCP_RELAY_PROTOCOL,
      authorization: "Bearer " + this.credentials[session]!.token
    } }, upgrade, Buffer.alloc(0));
    return id;
  }
  revoke(session: number) { this.policy.revokeSession(this.credentials[session]!.session.id); }
  async settle() { await this.scheduler.waitIdle(); }
  async stop() { await this.scheduler.waitFor(this.relay.close()); await this.settle(); }
  async dispose() {
    try { await this.stop(); }
    finally { rmSync(this.dir, { recursive: true, force: true }); }
  }
}

// Oracle: a set of live connections, a set of valid credentials and a hard
// limit. Every successful admission first retires invalid credentials; a
// disconnected/overflowed connection owns no backend after cleanup completes.
function assertState(model: Model, real: Desktop) {
  for (const [id, upgrade] of real.upgrades.entries()) {
    if (upgrade.status === 101) expect(upgrade.peer.readyState, `peer ${id}`).toBe(model.peers.has(id) ? 1 : 3);
  }
  expect(real.liveServers).toBe(model.peers.size);
  expect(real.peakServers).toBeLessThanOrEqual(16);
  expect(real.calls).toBe(model.calls);
}

type Action = "connect" | "disconnect" | "overflow" | "revoke" | "call" | "issue" | "stop" | "restart";
class Command implements fc.AsyncCommand<Model, Desktop> {
  constructor(readonly action: Action, readonly selector = 0, readonly count = 1) {}
  check(model: Readonly<Model>) {
    if (this.action === "restart") return model.stopped;
    if (model.stopped) return false;
    return !["disconnect", "overflow", "call"].includes(this.action) || model.peers.size > 0;
  }
  async run(model: Model, real: Desktop) {
    const session = this.selector % model.valid.length;
    const peerId = [...model.peers.keys()][this.selector % model.peers.size]!;
    switch (this.action) {
      case "connect": {
        // Invalid credentials cannot evict other clients or create a backend.
        if (model.valid[session]) {
          for (const [id, owner] of model.peers) if (!model.valid[owner]) model.peers.delete(id);
        }
        const available = 16 - model.peers.size;
        const expected = Array.from({ length: this.count }, (_, index) => !model.valid[session] ? 401 : index < available ? 101 : 429);
        const ids = Array.from({ length: this.count }, () => real.connect(session));
        await real.settle();
        expect(ids.map(id => real.upgrades[id]!.status).sort()).toEqual(expected.sort());
        for (const id of ids) if (real.upgrades[id]!.status === 101) model.peers.set(id, session);
        break;
      }
      case "revoke": real.revoke(session); model.valid[session] = false; break;
      case "issue": real.issue(); model.valid.push(true); break;
      case "disconnect": real.upgrades[peerId]!.peer.terminate(); model.peers.delete(peerId); break;
      case "overflow": {
        // Multiple permitted frames, one unfinished message larger than 64 KiB.
        const stream = real.upgrades[peerId]!.peer.stream;
        stream.emit("data", Buffer.alloc(this.count * 1024, "x"));
        stream.emit("data", Buffer.alloc(65 * 1024 - this.count * 1024, "x"));
        model.peers.delete(peerId);
        break;
      }
      case "call": {
        const owner = model.peers.get(peerId)!;
        real.upgrades[peerId]!.peer.stream.emit("data", Buffer.from(JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe", arguments: {} }
        }) + "\n"));
        if (model.valid[owner]) model.calls++; else model.peers.delete(peerId);
        break;
      }
      case "stop": await real.stop(); model.peers.clear(); model.stopped = true; break;
      case "restart": real.relay = real.start(); model.stopped = false; break;
    }
    await real.settle();
    assertState(model, real);
  }
  toString() { return `${this.action}(${this.selector}, ${this.count})`; }
}

const commands = fc.commands([
  fc.tuple(fc.nat(20), fc.integer({ min: 1, max: 4 })).map(([session, count]) => new Command("connect", session, count)),
  fc.nat(20).map(session => new Command("revoke", session)),
  fc.nat(20).map(peer => new Command("disconnect", peer)),
  fc.tuple(fc.nat(20), fc.integer({ min: 1, max: 64 })).map(([peer, size]) => new Command("overflow", peer, size)),
  fc.nat(20).map(peer => new Command("call", peer)),
  fc.constant(new Command("issue")), fc.constant(new Command("stop")), fc.constant(new Command("restart"))
], { maxCommands: 24 });

it.each(["overflow", "revocation"] as const)("matches the lifecycle model around %s with generated actions and completion orders", async boundary => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.integer({ min: 1, max: 64 }), commands, async (scheduler, fragment, actions) => {
    const real = new Desktop(scheduler);
    const model: Model = { valid: [true, true, true], peers: new Map(), stopped: false, calls: 0 };
    try {
      // Seed the real, reachable capacity boundary; random actions then move
      // through it rather than hoping a short generated trace reaches 16.
      await new Command("connect", 0, 16).run(model, real);
      if (boundary === "overflow") await new Command("overflow", 0, fragment).run(model, real);
      else await new Command("revoke", 0).run(model, real);
      await new Command("connect", 1, 1 + fragment % 4).run(model, real);
      await fc.asyncModelRun(() => ({ model, real }), actions);
    } finally { await real.dispose(); }
  }));
});

it("drains pending backend construction and rejects queued upgrades when the desktop stops", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.integer({ min: 2, max: 24 }), async (scheduler, count) => {
    const real = new Desktop(scheduler);
    try {
      for (let index = 0; index < count; index++) real.connect(index % 3);
      // Let construction begin, with further completions controlled by the
      // scheduler. Shutdown is a terminal boundary for these queued upgrades.
      await scheduler.waitNext(1);
      await real.stop();
      expect(real.liveServers).toBe(0);
      expect(real.peakServers).toBeLessThanOrEqual(16);
      for (const upgrade of real.upgrades) {
        if (upgrade.status === 101) expect(upgrade.peer.readyState).toBe(3);
        else if (upgrade.status === undefined) expect(upgrade.destroyed).toBe(true);
        // A capacity refusal may have completed before shutdown. It never
        // owned a backend and is not a queued upgrade for shutdown to reject.
        else expect(upgrade.status).toBe(429);
      }
    } finally { await real.dispose(); }
  }));
});
