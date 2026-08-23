import { once } from "node:events";
import { resolve } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_EVENT_PROTOCOL,
  LIVE_EVENT_SUBPROTOCOL,
  LiveEventServer,
  changedEvents
} from "./live-events.js";
import type { LiveStatusSnapshot } from "./types.js";

const servers: LiveEventServer[] = [];
const sockets: WebSocket[] = [];

function snapshot(overrides: Partial<LiveStatusSnapshot> = {}): LiveStatusSnapshot {
  return {
    observedAt: "2026-08-23T12:00:00.000Z",
    repositoryPath: resolve("/tmp/pwrgit-live-test"),
    identity: { provider: "github", host: "github.com", path: "acme/widget" },
    local: {
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
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
      number: 1,
      url: "https://github.com/acme/widget/pull/1",
      state: "open",
      draft: false,
      sourceBranch: "main",
      targetBranch: "main"
    },
    ci: {
      state: "running",
      total: 1,
      succeeded: 0,
      failed: 0,
      running: 1,
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
    providerAvailable: true,
    ...overrides
  };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) await server.close();
});

describe("live event contract", () => {
  it("emits distinct normalized events for requested status changes", () => {
    const previous = snapshot();
    const current = snapshot({
      ci: { ...previous.ci, state: "terminal_failure", failed: 1, running: 0 },
      mergeConflict: true,
      reviews: {
        decision: "changes_requested",
        blocking: true,
        blockingReason: "changes_requested",
        latest: [
          {
            id: "review-1",
            actor: "reviewer",
            state: "changes_requested",
            submittedAt: "2026-08-23T12:01:00Z"
          }
        ]
      }
    });
    expect(changedEvents(previous, current).map((event) => event.kind)).toEqual([
      "ci.status",
      "merge.conflict",
      "review.submitted",
      "review.blocking"
    ]);
  });

  it("notifies when a review blocker clears or provider availability changes", () => {
    const previous = snapshot({
      reviews: {
        decision: "changes_requested",
        blocking: true,
        blockingReason: "changes_requested",
        latest: []
      }
    });
    const current = snapshot({ providerAvailable: false });

    expect(changedEvents(previous, current).map((event) => event.kind)).toEqual([
      "repository.status",
      "review.blocking"
    ]);
  });

  it("serves the optional authenticated loopback WebSocket fallback", async () => {
    const server = new LiveEventServer(async () => snapshot());
    servers.push(server);
    await server.start();
    const capabilities = server.capabilities();
    expect(capabilities.mcp).toMatchObject({
      primary: "subscribable_status_resource",
      resourceSubscriptions: { supported: true }
    });
    expect(capabilities.websocket.authentication).toBe("ephemeral_capability_url");

    const messages: unknown[] = [];
    const socket = new WebSocket(
      capabilities.websocket.url,
      LIVE_EVENT_SUBPROTOCOL
    );
    sockets.push(socket);
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as unknown));
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        type: "subscribe",
        protocol: LIVE_EVENT_PROTOCOL,
        subscriptionId: "test-subscription",
        repositories: [resolve("/tmp/pwrgit-live-test")],
        intervalMs: 5_000
      })
    );
    await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(3));
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "hello", protocol: LIVE_EVENT_PROTOCOL })
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "subscribed",
        subscriptionId: "test-subscription"
      })
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "event",
        event: expect.objectContaining({
          protocol: LIVE_EVENT_PROTOCOL,
          kind: "snapshot",
          subscriptionId: "test-subscription"
        })
      })
    );
  });
});
