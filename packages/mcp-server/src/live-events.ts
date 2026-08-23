import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { isAbsolute } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createLiveStatusLoader, type LiveStatusLoader } from "./forge-status.js";
import type {
  LiveEventKind,
  LiveStatusEvent,
  LiveStatusSnapshot,
  ReviewSummary
} from "./types.js";

export const LIVE_EVENT_PROTOCOL = "pwrgit.events/v1" as const;
export const LIVE_EVENT_CONTRACT_VERSION = "1.0" as const;
export const LIVE_EVENT_SUBPROTOCOL = "pwrgit.events.v1" as const;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MS = 15_000;
const MAX_REPOSITORIES = 10;
const MAX_CONNECTIONS = 16;
const MAX_MESSAGE_BYTES = 64 * 1024;

type EventDescriptor = {
  kind: LiveEventKind;
  review?: ReviewSummary;
};

function comparable(value: unknown): string {
  return JSON.stringify(value);
}

export function changedEvents(
  previous: LiveStatusSnapshot | undefined,
  current: LiveStatusSnapshot
): EventDescriptor[] {
  if (previous === undefined) return [{ kind: "snapshot" }];
  const events: EventDescriptor[] = [];
  if (
    comparable(previous.local) !== comparable(current.local) ||
    comparable(previous.identity) !== comparable(current.identity) ||
    previous.providerAvailable !== current.providerAvailable
  ) {
    events.push({ kind: "repository.status" });
  }
  if (comparable(previous.ci) !== comparable(current.ci)) {
    events.push({ kind: "ci.status" });
  }
  if (previous.mergeConflict !== current.mergeConflict) {
    events.push({ kind: "merge.conflict" });
  }
  if (
    comparable(previous.changeRequest) !== comparable(current.changeRequest)
  ) {
    events.push({ kind: "change_request.state" });
  }
  const previousReviewIds = new Set(previous.reviews.latest.map((review) => review.id));
  for (const review of current.reviews.latest) {
    if (!previousReviewIds.has(review.id)) {
      events.push({ kind: "review.submitted", review });
    }
  }
  if (
    previous.reviews.blocking !== current.reviews.blocking ||
    previous.reviews.blockingReason !== current.reviews.blockingReason
  ) {
    events.push({ kind: "review.blocking" });
  }
  return events;
}

export type LiveEventCapabilities = {
  contract: "pwrgit.live-status";
  version: typeof LIVE_EVENT_CONTRACT_VERSION;
  mcp: {
    transport: "stdio";
    primary: "subscribable_status_resource";
    resourceSubscriptions: {
      supported: true;
      resourceTemplate: "pwrgit://status/v1/{watchId}";
      updateNotification: "notifications/resources/updated";
      behavior: string;
    };
  };
  websocket: {
    url: string;
    subprotocol: typeof LIVE_EVENT_SUBPROTOCOL;
    authentication: "ephemeral_capability_url";
    lifetime: "mcp_process";
  };
  messages: {
    client: readonly ["subscribe", "unsubscribe", "ping"];
    server: readonly ["hello", "subscribed", "event", "error", "pong"];
  };
  eventKinds: readonly LiveEventKind[];
  states: {
    ci: readonly [
      "success",
      "failure_with_running",
      "terminal_failure",
      "running",
      "pending",
      "none",
      "unknown"
    ];
    reviewBlockingReasons: readonly [
      "changes_requested",
      "approval_required",
      "blocking_discussion"
    ];
    changeRequest: readonly ["open", "merged", "closed"];
  };
  limits: {
    maxConnections: number;
    maxRepositoriesPerConnection: number;
    minPollIntervalMs: number;
    maxPollIntervalMs: number;
    maxMessageBytes: number;
  };
  privacy: {
    remoteCredentialsReturned: false;
    changedFilePathsReturned: false;
    boundedRepositoryList: true;
  };
};

type ActiveSubscription = {
  id: string;
  repositories: string[];
  intervalMs: number;
  timers: Set<NodeJS.Timeout>;
  previous: Map<string, LiveStatusSnapshot>;
  inFlight: Set<string>;
  stopped: boolean;
};

function loopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function allowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

export class LiveEventServer {
  private readonly host = "127.0.0.1";
  private readonly token = randomBytes(32).toString("base64url");
  private readonly loader: LiveStatusLoader;
  private http: HttpServer | null = null;
  private webSockets: WebSocketServer | null = null;
  private port: number | null = null;
  private sequence = 0;
  private connections = 0;

  constructor(loader: LiveStatusLoader = createLiveStatusLoader()) {
    this.loader = loader;
  }

  async start(): Promise<void> {
    if (this.http !== null) return;
    const http = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}');
    });
    const webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE_BYTES,
      handleProtocols(protocols) {
        return protocols.has(LIVE_EVENT_SUBPROTOCOL)
          ? LIVE_EVENT_SUBPROTOCOL
          : false;
      }
    });
    http.on("upgrade", (request, socket, head) => {
      const expectedHost = this.port === null ? null : `${this.host}:${this.port}`;
      let pathname = "";
      try {
        pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
      } catch {
        socket.destroy();
        return;
      }
      const protocols = new Set(
        (request.headers["sec-websocket-protocol"] ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      );
      if (
        !loopbackAddress(request.socket.remoteAddress) ||
        request.headers.host !== expectedHost ||
        !allowedOrigin(request.headers.origin) ||
        pathname !== `/events/v1/${this.token}` ||
        !protocols.has(LIVE_EVENT_SUBPROTOCOL) ||
        this.connections >= MAX_CONNECTIONS
      ) {
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (client) => {
        webSockets.emit("connection", client, request);
      });
    });
    webSockets.on("connection", (socket, request) => {
      this.handleConnection(socket, request);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (cause: Error): void => {
        http.off("listening", onListening);
        reject(cause);
      };
      const onListening = (): void => {
        http.off("error", onError);
        resolve();
      };
      http.once("error", onError);
      http.once("listening", onListening);
      http.listen(0, this.host);
    });
    const address = http.address();
    if (address === null || typeof address === "string") {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      throw new Error("live event server did not bind to a TCP loopback address");
    }
    this.http = http;
    this.webSockets = webSockets;
    this.port = address.port;
  }

  capabilities(): LiveEventCapabilities {
    if (this.port === null) throw new Error("live event server is not started");
    return {
      contract: "pwrgit.live-status",
      version: LIVE_EVENT_CONTRACT_VERSION,
      mcp: {
        transport: "stdio",
        primary: "subscribable_status_resource",
        resourceSubscriptions: {
          supported: true,
          resourceTemplate: "pwrgit://status/v1/{watchId}",
          updateNotification: "notifications/resources/updated",
          behavior:
            "Call pwrgit_watch_repository, read the returned URI, subscribe with resources/subscribe, and re-read after each notifications/resources/updated notification. The WebSocket is an optional fallback for hosts that do not expose MCP resource subscriptions."
        }
      },
      websocket: {
        url: `ws://${this.host}:${this.port}/events/v1/${this.token}`,
        subprotocol: LIVE_EVENT_SUBPROTOCOL,
        authentication: "ephemeral_capability_url",
        lifetime: "mcp_process"
      },
      messages: {
        client: ["subscribe", "unsubscribe", "ping"],
        server: ["hello", "subscribed", "event", "error", "pong"]
      },
      eventKinds: [
        "snapshot",
        "repository.status",
        "ci.status",
        "merge.conflict",
        "review.submitted",
        "review.blocking",
        "change_request.state"
      ],
      states: {
        ci: [
          "success",
          "failure_with_running",
          "terminal_failure",
          "running",
          "pending",
          "none",
          "unknown"
        ],
        reviewBlockingReasons: [
          "changes_requested",
          "approval_required",
          "blocking_discussion"
        ],
        changeRequest: ["open", "merged", "closed"]
      },
      limits: {
        maxConnections: MAX_CONNECTIONS,
        maxRepositoriesPerConnection: MAX_REPOSITORIES,
        minPollIntervalMs: MIN_INTERVAL_MS,
        maxPollIntervalMs: MAX_INTERVAL_MS,
        maxMessageBytes: MAX_MESSAGE_BYTES
      },
      privacy: {
        remoteCredentialsReturned: false,
        changedFilePathsReturned: false,
        boundedRepositoryList: true
      }
    };
  }

  async close(): Promise<void> {
    const http = this.http;
    const webSockets = this.webSockets;
    this.http = null;
    this.webSockets = null;
    this.port = null;
    if (webSockets !== null) {
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    }
    if (http !== null) {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  private handleConnection(socket: WebSocket, _request: IncomingMessage): void {
    this.connections += 1;
    let active: ActiveSubscription | null = null;
    send(socket, {
      type: "hello",
      protocol: LIVE_EVENT_PROTOCOL,
      version: LIVE_EVENT_CONTRACT_VERSION,
      minPollIntervalMs: MIN_INTERVAL_MS,
      maxRepositories: MAX_REPOSITORIES
    });

    const stop = (): void => {
      if (active === null) return;
      active.stopped = true;
      for (const timer of active.timers) clearInterval(timer);
      active.timers.clear();
      active = null;
    };
    socket.on("close", () => {
      stop();
      this.connections = Math.max(0, this.connections - 1);
    });
    socket.on("error", () => undefined);
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        send(socket, { type: "error", code: "text_messages_only" });
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(raw.toString()) as unknown;
      } catch {
        send(socket, { type: "error", code: "invalid_json" });
        return;
      }
      if (message === null || typeof message !== "object" || Array.isArray(message)) {
        send(socket, { type: "error", code: "invalid_message" });
        return;
      }
      const input = message as Record<string, unknown>;
      if (input.type === "ping") {
        send(socket, { type: "pong", protocol: LIVE_EVENT_PROTOCOL });
        return;
      }
      if (input.type === "unsubscribe") {
        stop();
        send(socket, { type: "subscribed", active: false });
        return;
      }
      if (input.type !== "subscribe") {
        send(socket, { type: "error", code: "unknown_message_type" });
        return;
      }
      if (input.protocol !== LIVE_EVENT_PROTOCOL) {
        send(socket, { type: "error", code: "unsupported_protocol" });
        return;
      }
      const repositories = Array.isArray(input.repositories)
        ? [...new Set(input.repositories.filter((path): path is string => typeof path === "string"))]
        : [];
      if (
        repositories.length === 0 ||
        repositories.length > MAX_REPOSITORIES ||
        repositories.some((path) => path.length > 4_096 || !isAbsolute(path))
      ) {
        send(socket, { type: "error", code: "invalid_repositories" });
        return;
      }
      const requestedInterval =
        typeof input.intervalMs === "number" && Number.isInteger(input.intervalMs)
          ? input.intervalMs
          : DEFAULT_INTERVAL_MS;
      const intervalMs = Math.min(
        MAX_INTERVAL_MS,
        Math.max(MIN_INTERVAL_MS, requestedInterval)
      );
      const requestedId =
        typeof input.subscriptionId === "string" &&
        /^[A-Za-z0-9_.-]{1,100}$/.test(input.subscriptionId)
          ? input.subscriptionId
          : randomUUID();
      stop();
      active = {
        id: requestedId,
        repositories,
        intervalMs,
        timers: new Set(),
        previous: new Map(),
        inFlight: new Set(),
        stopped: false
      };
      const subscription = active;
      send(socket, {
        type: "subscribed",
        active: true,
        protocol: LIVE_EVENT_PROTOCOL,
        subscriptionId: requestedId,
        repositories,
        intervalMs
      });
      for (const repositoryPath of repositories) {
        void this.poll(socket, subscription, repositoryPath);
        const timer = setInterval(() => {
          void this.poll(socket, subscription, repositoryPath);
        }, intervalMs);
        timer.unref();
        subscription.timers.add(timer);
      }
    });
  }

  private async poll(
    socket: WebSocket,
    subscription: ActiveSubscription,
    repositoryPath: string
  ): Promise<void> {
    if (
      subscription.stopped ||
      subscription.inFlight.has(repositoryPath) ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    subscription.inFlight.add(repositoryPath);
    try {
      const current = await this.loader(repositoryPath);
      if (subscription.stopped) return;
      const previous = subscription.previous.get(repositoryPath);
      subscription.previous.set(repositoryPath, current);
      for (const descriptor of changedEvents(previous, current)) {
        this.sequence += 1;
        const event: LiveStatusEvent = {
          protocol: LIVE_EVENT_PROTOCOL,
          id: randomUUID(),
          sequence: this.sequence,
          emittedAt: new Date().toISOString(),
          subscriptionId: subscription.id,
          repositoryPath: current.repositoryPath,
          kind: descriptor.kind,
          snapshot: current,
          ...(previous === undefined ? {} : { previous }),
          ...(descriptor.review === undefined ? {} : { review: descriptor.review })
        };
        send(socket, { type: "event", event });
      }
    } catch (cause) {
      send(socket, {
        type: "error",
        code: "status_unavailable",
        repositoryPath,
        message: errorMessage(cause)
      });
    } finally {
      subscription.inFlight.delete(repositoryPath);
    }
  }
}
