import type { Readable, Writable } from "node:stream";
import WebSocket, { createWebSocketStream } from "ws";
import {
  AGENT_ACCESS_PORT, MCP_RELAY_PATH, MCP_RELAY_PROTOCOL, MCP_DESKTOP_VERSION_HEADER
} from "./agent-access-protocol.js";
import { MCP_PACKAGE_VERSION } from "./version.js";

export const RECONNECT_INSTRUCTIONS = "Open PwrGit yourself, enable Settings → Local Agents → Enable local-agent access, then reconnect the MCP server in your host. This relay never launches PwrGit or retries/replays requests. Older desktops need an update to support the stdio relay; HTTP OAuth clients can continue using /mcp.";

/** Opaque byte relay: no MCP client, tool registry, policy file, Git or app launcher. */
export async function relayStdio(options: {
  port?: number;
  token?: string;
  input?: Readable;
  output?: Writable;
  diagnostics?: Writable;
} = {}): Promise<void> {
  const token = options.token ?? process.env.PWRGIT_MCP_SESSION_TOKEN;
  if (!token?.trim()) throw new Error("PWRGIT_MCP_SESSION_TOKEN is required. Existing stdio clients keep their saved Session token; new clients should use desktop HTTP OAuth. " + RECONNECT_INSTRUCTIONS);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostics = options.diagnostics ?? process.stderr;
  const socket = new WebSocket(`ws://127.0.0.1:${options.port ?? AGENT_ACCESS_PORT}${MCP_RELAY_PATH}`, MCP_RELAY_PROTOCOL, {
    headers: { authorization: `Bearer ${token}`, "x-pwrgit-relay-version": MCP_PACKAGE_VERSION },
    handshakeTimeout: 5_000,
    maxPayload: 16 * 1024 * 1024,
    followRedirects: false
  });
  let desktopVersion: string | undefined;
  socket.on("upgrade", response => {
    const header = response.headers[MCP_DESKTOP_VERSION_HEADER];
    if (typeof header === "string") desktopVersion = header;
  });
  await new Promise<void>((resolve, reject) => {
    const fail = () => { socket.terminate(); reject(new Error("Cannot connect to the authenticated PwrGit desktop relay. Check that your Session is valid. " + RECONNECT_INSTRUCTIONS)); };
    socket.once("error", fail);
    socket.once("unexpected-response", (_request, response) => { response.resume(); fail(); });
    socket.once("open", () => { socket.off("error", fail); resolve(); });
  });
  diagnostics.write(`[pwrgit-mcp] relay ${MCP_PACKAGE_VERSION}; desktop ${desktopVersion ?? "unknown"}; transport ${MCP_RELAY_PROTOCOL}\n`);
  const stream = createWebSocketStream(socket);
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let inputEnded = false;
    const finish = (cause?: Error) => {
      if (finished) return;
      finished = true;
      input.unpipe(stream);
      input.pause();
      stream.unpipe(output);
      input.off("end", onEnd);
      input.off("error", onError);
      output.off("error", onError);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      socket.terminate();
      stream.destroy();
      if (cause) reject(cause); else resolve();
    };
    const onEnd = () => { inputEnded = true; stream.end(); };
    const onError = () => finish(new Error("PwrGit relay I/O failed. " + RECONNECT_INSTRUCTIONS));
    const onSignal = () => finish();
    input.once("end", onEnd);
    input.once("error", onError);
    output.once("error", onError);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    stream.on("error", onError);
    // ws ends the readable half on remote close, but does not automatically
    // close a still-writable Duplex. Observe EOF to exit even while stdin is open.
    stream.once("end", () => finish(inputEnded ? undefined : new Error("PwrGit desktop disconnected. " + RECONNECT_INSTRUCTIONS)));
    stream.once("close", () => finish(inputEnded ? undefined : new Error("PwrGit desktop disconnected. " + RECONNECT_INSTRUCTIONS)));
    stream.pipe(output, { end: false });
    input.pipe(stream, { end: false });
  });
}
