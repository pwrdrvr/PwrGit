import { once } from "node:events";
import { PassThrough } from "node:stream";
import fc from "fast-check";
import { WebSocketServer, type WebSocket } from "ws";
import { relayStdio } from "./stdio-relay.js";
import { expect, it } from "vitest";

function chunks(bytes: Buffer, sizes: number[]): Buffer[] {
  const result: Buffer[] = [];
  let offset = 0;
  for (const size of sizes) {
    result.push(bytes.subarray(offset, offset + size));
    offset += size;
    if (offset >= bytes.length) return result;
  }
  result.push(bytes.subarray(offset));
  return result;
}

it("is identical to direct byte copying in both directions for generated data and fragment boundaries", async () => {
  const websocket = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(websocket, "listening");
  const port = (websocket.address() as { port: number }).port;
  type Trial = { up: Buffer; down: Buffer; cuts: number[]; received: Buffer[]; socket?: WebSocket };
  let trial: Trial;
  let connections = 0;
  websocket.on("connection", socket => {
    const current = trial;
    current.socket = socket;
    connections++;
    socket.on("message", data => {
      current.received.push(Buffer.from(data as Buffer));
      if (Buffer.concat(current.received).length === current.up.length) {
        for (const fragment of chunks(current.down, current.cuts)) socket.send(fragment);
      }
    });
  });
  try {
    await fc.assert(fc.asyncProperty(
      fc.uint8Array({ minLength: 1, maxLength: 4096 }),
      fc.uint8Array({ minLength: 1, maxLength: 4096 }),
      fc.array(fc.integer({ min: 1, max: 256 }), { maxLength: 32 }),
      fc.array(fc.integer({ min: 1, max: 256 }), { maxLength: 32 }),
      async (up, down, upCuts, downCuts) => {
        trial = { up: Buffer.from(up), down: Buffer.from(down), cuts: downCuts, received: [] };
        const current = trial;
        const connectionCount = connections;
        const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
        const received: Buffer[] = [];
        let resolve!: () => void;
        const delivered = new Promise<void>(done => { resolve = done; });
        output.on("data", bytes => {
          received.push(bytes);
          if (Buffer.concat(received).length >= down.length) resolve();
        });
        const relay = relayStdio({ port, token: "transport-fixture", input, output, diagnostics }).then(
          () => undefined, (error: unknown) => error
        );
        try {
          for (const fragment of chunks(current.up, upCuts)) input.write(fragment);
          await delivered;
          // Differential oracle: direct identity copying, independent of JSON,
          // UTF-8 decoding, MCP schemas, message types and packet boundaries.
          expect(Buffer.concat(current.received)).toEqual(current.up);
          expect(Buffer.concat(received)).toEqual(current.down);
          current.socket!.terminate();
          expect(await relay).toBeInstanceOf(Error);
          // A disconnected relay cannot reconnect or replay buffered/new input.
          input.write("must not replay");
          expect(input.readableLength).toBeGreaterThan(0);
          expect(connections).toBe(connectionCount + 1);
          expect(Buffer.concat(current.received)).toEqual(current.up);
        } finally {
          current.socket?.terminate();
          input.end();
          await relay;
        }
      }
    ));
  } finally {
    for (const socket of websocket.clients) socket.terminate();
    await new Promise<void>(resolve => websocket.close(() => resolve()));
  }
});
