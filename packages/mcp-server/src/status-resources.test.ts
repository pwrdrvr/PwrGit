import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { StatusResourceRegistry } from "./status-resources.js";
import type { LiveStatusSnapshot } from "./types.js";
import {
  FixedMcpAuthorizer,
  fullAccessAuthorization
} from "./access-policy.js";

function snapshot(repositoryPath: string): LiveStatusSnapshot {
  return {
    observedAt: "2026-08-23T12:00:00.000Z",
    repositoryPath,
    identity: null,
    local: {
      branch: "main",
      upstream: null,
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
    changeRequest: null,
    ci: {
      state: "none",
      total: 0,
      succeeded: 0,
      failed: 0,
      running: 0,
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
    providerAvailable: false
  };
}

function registry(loader: (path: string) => Promise<LiveStatusSnapshot>) {
  const mcp = new McpServer({ name: "status-resource-test", version: "1.0.0" });
  return new StatusResourceRegistry(
    mcp,
    loader,
    new FixedMcpAuthorizer(fullAccessAuthorization())
  );
}

describe("status resource capacity", () => {
  it("reserves capacity before concurrent initial loads finish", async () => {
    let resolveLoad!: (value: LiveStatusSnapshot) => void;
    const loading = new Promise<LiveStatusSnapshot>((resolve) => {
      resolveLoad = resolve;
    });
    const resources = registry(async () => loading);
    const pending = Array.from({ length: 64 }, (_, index) =>
      resources.create(`/repo/${index}`)
    );

    await expect(resources.create("/repo/overflow")).rejects.toThrow(
      "live status watch limit reached (64)"
    );
    resolveLoad(snapshot("/repo/canonical"));
    await expect(Promise.all(pending)).resolves.toHaveLength(64);
    resources.close();
  });

  it("releases a reservation when the initial load fails", async () => {
    let attempts = 0;
    const resources = registry(async (path) => {
      attempts += 1;
      if (attempts === 1) throw new Error("provider unavailable");
      return snapshot(path);
    });

    await expect(resources.create("/repo/failure")).rejects.toThrow(
      "provider unavailable"
    );
    await expect(
      Promise.all(
        Array.from({ length: 64 }, (_, index) =>
          resources.create(`/repo/${index}`)
        )
      )
    ).resolves.toHaveLength(64);
    await expect(resources.create("/repo/overflow")).rejects.toThrow(
      "live status watch limit reached (64)"
    );
    resources.close();
  });
});
