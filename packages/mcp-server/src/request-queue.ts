import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

const MAX_ACTIVE = 8;
const MAX_PENDING = 128;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
type Pending = { bytes: number; start: () => void };

/** Per-session application work, rather than transport messages. The SDK does
 * not send a response after cancellation, and a handler may ignore its signal:
 * only the handler's settlement can safely release an active slot. */
export class McpRequestQueue {
  private active = 0;
  private pendingBytes = 0;
  private readonly pending: Pending[] = [];

  async run<T>(work: () => T | Promise<T>, signal: AbortSignal, request: unknown): Promise<T> {
    signal.throwIfAborted();
    if (this.active < MAX_ACTIVE) return this.execute(work);
    const bytes = Buffer.byteLength(JSON.stringify(request));
    if (this.pending.length >= MAX_PENDING || this.pendingBytes + bytes > MAX_PENDING_BYTES)
      throw new McpError(-32000, "MCP session request queue is full; retry after current requests finish");
    return new Promise<T>((resolve, reject) => {
      const cancel = (): void => {
        const index = this.pending.indexOf(entry);
        if (index < 0) return;
        this.pending.splice(index, 1);
        this.pendingBytes -= bytes;
        signal.removeEventListener("abort", cancel);
        reject(signal.reason);
      };
      const entry: Pending = {
        bytes,
        start: () => {
          signal.removeEventListener("abort", cancel);
          // A queued cancellation must never start application work.
          if (signal.aborted) reject(signal.reason);
          else void this.execute(work).then(resolve, reject);
        }
      };
      this.pending.push(entry);
      this.pendingBytes += bytes;
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  private async execute<T>(work: () => T | Promise<T>): Promise<T> {
    this.active++;
    try { return await work(); }
    finally {
      this.active--;
      while (this.active < MAX_ACTIVE && this.pending.length > 0) {
        const next = this.pending.shift()!;
        this.pendingBytes -= next.bytes;
        next.start();
      }
    }
  }
}

/** Install before registering application handlers, including handlers added
 * later by tools/resources/prompts. Notifications and replies to server-originated
 * requests never enter this queue, so cancellation and elicitation can progress. */
export function limitMcpRequests(server: Server): void {
  const queue = new McpRequestQueue();
  const register = server.setRequestHandler.bind(server);
  server.setRequestHandler = (schema, handler) => {
    register(schema, (request, extra) => queue.run(() => handler(request, extra), extra.signal, request));
  };
}
