import { randomBytes } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { changedEvents } from "./live-events.js";
import type { LiveStatusLoader } from "./forge-status.js";
import type { LiveStatusSnapshot } from "./types.js";

export const STATUS_RESOURCE_PROTOCOL = "pwrgit.status-resource/v1" as const;
export const STATUS_RESOURCE_VERSION = "1.0" as const;
const STATUS_RESOURCE_TEMPLATE = "pwrgit://status/v1/{watchId}";
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MS = 15_000;
const MAX_WATCHES = 64;

type Watch = {
  id: string;
  uri: string;
  repositoryPath: string;
  intervalMs: number;
  snapshot: LiveStatusSnapshot;
  timer: NodeJS.Timeout | null;
  polling: boolean;
  subscribed: boolean;
};

export type StatusResourceDocument = {
  protocol: typeof STATUS_RESOURCE_PROTOCOL;
  version: typeof STATUS_RESOURCE_VERSION;
  resourceUri: string;
  intervalMs: number;
  snapshot: LiveStatusSnapshot;
};

function watchIdFromUri(uri: string): string | null {
  const match = /^pwrgit:\/\/status\/v1\/([A-Za-z0-9_-]{32})$/.exec(uri);
  return match?.[1] ?? null;
}

function normalizedInterval(intervalMs: number | undefined): number {
  return Math.min(
    MAX_INTERVAL_MS,
    Math.max(MIN_INTERVAL_MS, intervalMs ?? DEFAULT_INTERVAL_MS)
  );
}

export class StatusResourceRegistry {
  private readonly watches = new Map<string, Watch>();
  private pendingWatches = 0;

  constructor(
    private readonly mcp: McpServer,
    private readonly loader: LiveStatusLoader
  ) {
    mcp.registerResource(
      "pwrgit-live-status",
      new ResourceTemplate(STATUS_RESOURCE_TEMPLATE, { list: undefined }),
      {
        title: "PwrGit live repository status v1",
        description:
          "Versioned normalized local Git, PR/MR, CI, merge-conflict, and review status. Obtain a concrete URI from pwrgit_watch_repository, subscribe to it, and re-read it after notifications/resources/updated.",
        mimeType: "application/json"
      },
      async (uri) => {
        const watch = this.requireWatch(uri.toString());
        if (!watch.subscribed) await this.refresh(watch, false);
        return {
          contents: [
            {
              uri: watch.uri,
              mimeType: "application/json",
              text: JSON.stringify(this.document(watch))
            }
          ]
        };
      }
    );
    mcp.server.registerCapabilities({
      resources: { listChanged: true, subscribe: true }
    });
    mcp.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      const watch = this.requireWatch(request.params.uri);
      this.subscribe(watch);
      return {};
    });
    mcp.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      const watch = this.requireWatch(request.params.uri);
      this.unsubscribe(watch);
      return {};
    });
  }

  async create(
    repositoryPath: string,
    intervalMs?: number
  ): Promise<StatusResourceDocument> {
    if (this.watches.size + this.pendingWatches >= MAX_WATCHES) {
      throw new Error(`live status watch limit reached (${MAX_WATCHES})`);
    }
    this.pendingWatches += 1;
    try {
      const id = randomBytes(24).toString("base64url");
      const snapshot = await this.loader(repositoryPath);
      const watch: Watch = {
        id,
        uri: `pwrgit://status/v1/${id}`,
        repositoryPath: snapshot.repositoryPath,
        intervalMs: normalizedInterval(intervalMs),
        snapshot,
        timer: null,
        polling: false,
        subscribed: false
      };
      this.watches.set(id, watch);
      return this.document(watch);
    } finally {
      this.pendingWatches -= 1;
    }
  }

  close(): void {
    for (const watch of this.watches.values()) this.unsubscribe(watch);
    this.watches.clear();
  }

  private document(watch: Watch): StatusResourceDocument {
    return {
      protocol: STATUS_RESOURCE_PROTOCOL,
      version: STATUS_RESOURCE_VERSION,
      resourceUri: watch.uri,
      intervalMs: watch.intervalMs,
      snapshot: watch.snapshot
    };
  }

  private requireWatch(uri: string): Watch {
    const id = watchIdFromUri(uri);
    const watch = id === null ? undefined : this.watches.get(id);
    if (watch === undefined) {
      throw new McpError(ErrorCode.InvalidParams, "unknown or expired PwrGit status resource");
    }
    return watch;
  }

  private subscribe(watch: Watch): void {
    if (watch.subscribed) return;
    watch.subscribed = true;
    watch.timer = setInterval(() => {
      void this.refresh(watch, true).catch(() => undefined);
    }, watch.intervalMs);
    watch.timer.unref();
  }

  private unsubscribe(watch: Watch): void {
    watch.subscribed = false;
    if (watch.timer !== null) clearInterval(watch.timer);
    watch.timer = null;
  }

  private async refresh(watch: Watch, notify: boolean): Promise<void> {
    if (watch.polling) return;
    watch.polling = true;
    try {
      const current = await this.loader(watch.repositoryPath);
      const changed = changedEvents(watch.snapshot, current).length > 0;
      watch.snapshot = current;
      if (notify && watch.subscribed && changed) {
        await this.mcp.server.sendResourceUpdated({ uri: watch.uri });
      }
    } finally {
      watch.polling = false;
    }
  }
}
