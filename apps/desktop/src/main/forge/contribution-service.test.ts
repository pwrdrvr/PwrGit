import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import {
  ContributionService,
  type ContributionScope
} from "./contribution-service";
import {
  GitHubContributionProvider,
  ContributionSsoError,
  type ContributionProvider
} from "./github/contribution-provider";
import type { ContributionRepo, ContributionRecord } from "@pwrgit/shared";

const identity = { id: "U1", login: "sample-user", host: "github.com" };
const repo: ContributionRepo = {
  id: "R1",
  path: "sample-org/widget",
  owner: "sample-org",
  ownerId: "O1",
  ownerKind: "organization",
  archived: true,
  fork: true,
  visibility: "PRIVATE"
};
const scope: ContributionScope = {
  profileId: "profile1",
  host: "github.com",
  viewerId: "U1",
  startDate: "2026-04-11",
  endDate: "2026-10-10",
  timezone: "America/New_York"
};
const row = (
  id: string,
  mergedAt = "2026-05-01T04:00:00Z"
): ContributionRecord => ({
  id,
  repo,
  number: 1,
  mergedAt,
  mergedBy: "U1",
  author: "U2"
});
const page = <T>(nodes: T[], cursor: string | null = null, more = false) => ({
  nodes,
  cursor,
  more,
  totalCount: nodes.length
});
const hosts = {
  kindFor: () => ({ kind: "github" as const, source: "auto" as const }),
  isEnabled: () => ({ enabled: true, source: "auto" as const })
};
const databases: DB[] = [];
const base = (): ContributionProvider => ({
  verify: async () => identity,
  repositories: async () => page([repo]),
  organizations: async () => page(["sample-org"]),
  pulls: async () => ({
    ...page([row("P1")]),
    oldestUpdatedAt: "2026-05-01T04:00:00Z",
    openCount: 0
  }),
  authored: async () => page([]),
  timelines: async () => []
});
function setup(
  provider = base(),
  pause: (signal: AbortSignal) => Promise<void> = async () => {},
  hostGate = hosts
) {
  const db = openDatabase(":memory:");
  databases.push(db);
  db.prepare("INSERT INTO profiles(id,name,email) VALUES(?,?,?)").run(
    "profile1",
    "Sample",
    "sample@example.test"
  );
  db.prepare("INSERT INTO profiles(id,name,email) VALUES(?,?,?)").run(
    "profile2",
    "Other",
    "other@example.test"
  );
  const service = new ContributionService(db, hostGate, () => provider, pause);
  return { db, service };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
describe("local contribution checkpoints", () => {
  it.each([
    ["repositories", "Repository discovery", null],
    ["organizations", "Organization discovery", null],
    ["authored", "Authored PR inventory", null],
    ["pulls", "Repository PR collection", repo.id]
  ] as const)(
    "identifies a failed %s stage without blaming an unrelated repository",
    async (method, stage, repoId) => {
      const provider = base();
      provider[method] = async () => {
        throw new Error(
          "SAML SSO authorization required; resume after authorizing GitHub CLI."
        );
      };
      const { service } = setup(provider);
      await service.start(scope, false);
      await service.settled();
      expect(service.read(scope)).toMatchObject({
        status: "partial",
        repoIndex: 0,
        issues: [
          {
            repoId,
            message: `${stage}: SAML SSO authorization required; resume after authorizing GitHub CLI.`
          }
        ]
      });
      expect(service.read({ ...scope, profileId: "profile2" })).toBeNull();
    }
  );
  it("keeps authored pages and resumes their cursor after an SSO refusal", async () => {
    const provider = base();
    let authorized = false;
    const cursors: (string | null)[] = [];
    provider.authored = async (_identity, cursor) => {
      cursors.push(cursor);
      if (cursor === "PAGE_3" && !authorized)
        throw new Error("SAML SSO authorization required.");
      const index = cursor === "PAGE_3" ? 3 : cursor === "PAGE_2" ? 2 : 1;
      return {
        ...page<ContributionRecord>(
          [
            {
              ...row(`A${index}`),
              author: identity.id,
              mergedAt: null,
              lifecycle: {
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-02-01T00:00:00Z",
                closedAt: "2025-02-01T00:00:00Z",
                state: "CLOSED",
                events: [],
                complete: false,
                cursor: null
              }
            }
          ],
          `PAGE_${index + 1}`,
          index < 3
        ),
        totalCount: 3
      };
    };
    provider.pulls = vi.fn(provider.pulls);
    const { db, service } = setup(provider);
    await service.start(scope, false);
    await service.settled();
    const partial = service.read(scope)!;
    expect(partial).toMatchObject({
      status: "partial",
      repoIndex: 0,
      authoredInventory: { received: 2, cursor: "PAGE_3", complete: false },
      issues: [
        {
          repoId: null,
          message: "Authored PR inventory: SAML SSO authorization required."
        }
      ]
    });
    expect(partial.records.map((record) => record.id)).toEqual(["A1", "A2"]);
    expect(provider.pulls).not.toHaveBeenCalled();
    authorized = true;
    const restarted = new ContributionService(
      db,
      hosts,
      () => provider,
      async () => {}
    );
    await restarted.start(scope, false);
    await restarted.settled();
    const complete = restarted.read(scope)!;
    expect(complete.status).toBe("complete");
    expect(complete.authoredInventory).toMatchObject({
      received: 3,
      complete: true
    });
    expect(complete.records.map((record) => record.id)).toEqual([
      "A1",
      "A2",
      "A3",
      "P1"
    ]);
    expect(complete.window).toEqual(partial.window);
    expect(complete.startedAt).toBe(partial.startedAt);
    expect(complete.issues).toEqual([]);
    expect(cursors).toEqual([null, "PAGE_2", "PAGE_3", "PAGE_3"]);
    expect(service.read({ ...scope, profileId: "profile2" })).toBeNull();
  });
  it("finishes accessible activity after a blocked authored page and retries the gap after restart", async () => {
    const provider = base();
    let authorized = false;
    const cursors: (string | null)[] = [];
    provider.authored = async (_identity, cursor) => {
      cursors.push(cursor);
      const index = cursor ? 2 : 1;
      const nodes: ContributionRecord[] = [
        {
          ...row(`A${index}`),
          author: identity.id,
          mergedAt: null,
          lifecycle: {
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-02-01T00:00:00Z",
            closedAt: "2025-02-01T00:00:00Z",
            state: "CLOSED",
            events: [],
            complete: false,
            cursor: null
          }
        }
      ];
      if (!cursor && authorized) nodes.push({ ...nodes[0]!, id: "RECOVERED" });
      return {
        ...page(nodes, cursor ? null : "NEXT", !cursor),
        totalCount: 3,
        ...(!cursor && !authorized
          ? {
              skipped: 1,
              blockedOrganizations: [{ id: "42", login: "blocked-org" }]
            }
          : {})
      };
    };
    provider.pulls = vi.fn(provider.pulls);
    const { db, service } = setup(provider);
    await service.start(scope, false);
    await service.settled();
    const partial = service.read(scope)!;
    expect(partial).toMatchObject({
      status: "partial",
      accessibleComplete: true,
      repoIndex: 1,
      authoredInventory: {
        received: 2,
        skipped: 1,
        exhausted: true,
        complete: false
      },
      blockedOrganizations: [{ id: "42", login: "blocked-org" }]
    });
    expect(partial.records.map((record) => record.id)).toEqual([
      "A1",
      "A2",
      "P1"
    ]);
    expect(provider.pulls).toHaveBeenCalledTimes(1);
    authorized = true;
    const restarted = new ContributionService(
      db,
      hosts,
      () => provider,
      async () => {}
    );
    await restarted.start(scope, false);
    await restarted.settled();
    const complete = restarted.read(scope)!;
    expect(complete.status).toBe("complete");
    expect(complete.authoredInventory).toMatchObject({
      received: 3,
      skipped: 0,
      complete: true
    });
    expect(complete.records.some((record) => record.id === "RECOVERED")).toBe(
      true
    );
    expect(complete.blockedOrganizations).toEqual([]);
    expect(complete.window).toEqual(partial.window);
    expect(cursors).toEqual([null, "NEXT", null, "NEXT"]);
    expect(service.read({ ...scope, profileId: "profile2" })).toBeNull();
  });
  it("skips the rest of an SSO-blocked organization and continues other repositories", async () => {
    const provider = base();
    const blocked = {
      ...repo,
      id: "BLOCKED",
      owner: "blocked-org",
      ownerId: "O42",
      path: "blocked-org/one"
    };
    provider.repositories = async () =>
      page([
        blocked,
        { ...blocked, id: "BLOCKED2", path: "blocked-org/two" },
        repo
      ]);
    const calls: string[] = [];
    let authorized = false;
    const denied = new GitHubContributionProvider(identity.host, async () =>
      JSON.stringify({
        data: {
          viewer: identity,
          rateLimit: { remaining: 4000, resetAt: "2026-10-28T00:00:00Z" },
          node: null
        },
        errors: [
          {
            type: "FORBIDDEN",
            extensions: { saml_failure: true },
            message: "SAML enforcement"
          }
        ]
      })
    );
    provider.pulls = async (viewer, item, cursor, signal) => {
      calls.push(item.id);
      if (item.owner === "blocked-org" && !authorized)
        return denied.pulls(viewer, item, cursor, signal);
      return {
        ...page([
          {
            ...row(item.id === repo.id ? "ACCESSIBLE" : `RECOVERED_${item.id}`),
            repo: item
          }
        ]),
        oldestUpdatedAt: "2026-05-01T00:00:00Z"
      };
    };
    const { service } = setup(provider);
    await service.start(scope, false);
    await service.settled();
    expect(calls).toEqual(["BLOCKED", repo.id]);
    expect(service.read(scope)).toMatchObject({
      status: "partial",
      accessibleComplete: true,
      repoIndex: 3,
      blockedRepoIds: ["BLOCKED", "BLOCKED2"],
      blockedOrganizations: [{ login: "blocked-org" }],
      records: [{ id: "ACCESSIBLE" }]
    });
    authorized = true;
    await service.start(scope, false);
    await service.settled();
    expect(service.read(scope)).toMatchObject({
      status: "complete",
      blockedRepoIds: [],
      blockedOrganizations: []
    });
    expect(service.read(scope)?.records).toHaveLength(3);
    expect(calls).toEqual(["BLOCKED", repo.id, "BLOCKED", "BLOCKED2", repo.id]);
  });
  it("isolates SSO failures in mixed lifecycle batches and retries skipped histories", async () => {
    const provider = base();
    let authorized = false;
    const blockedRepo = {
      ...repo,
      id: "B",
      owner: "blocked-org",
      path: "blocked-org/widget"
    };
    const rows: ContributionRecord[] = ["BLOCKED1", "OPEN", "BLOCKED2"].map(
      (id) => ({
        ...row(id),
        repo: id === "OPEN" ? repo : blockedRepo,
        author: identity.id,
        mergedAt: null,
        lifecycle: {
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-06-01T00:00:00Z",
          closedAt: null,
          state: "OPEN",
          events: [],
          complete: false,
          cursor: null
        }
      })
    );
    provider.authored = async () =>
      page(rows.map((row) => structuredClone(row)));
    const calls: string[][] = [];
    provider.timelines = async (_identity, items) => {
      calls.push(items.map((item) => item.id));
      if (!authorized && items.some((item) => item.repo.id === "B"))
        throw new ContributionSsoError();
      return items.map((item) => ({
        id: item.id,
        events: [],
        cursor: null,
        more: false,
        filteredCount: 0
      }));
    };
    const { service } = setup(provider);
    await service.start(scope, false);
    await service.settled();
    const partial = service.read(scope)!;
    expect(partial).toMatchObject({
      status: "partial",
      accessibleComplete: true
    });
    expect(
      partial.records.find((row) => row.id === "OPEN")?.lifecycle?.complete
    ).toBe(true);
    expect(calls).toEqual([
      ["BLOCKED1", "OPEN", "BLOCKED2"],
      ["BLOCKED1"],
      ["OPEN"]
    ]);
    authorized = true;
    await service.start(scope, false);
    await service.settled();
    expect(service.read(scope)?.status).toBe("complete");
    expect(
      service
        .read(scope)
        ?.records.filter((row) => row.lifecycle)
        .every((row) => row.lifecycle?.complete)
    ).toBe(true);
    expect(calls.at(-1)).toEqual(["BLOCKED1", "BLOCKED2"]);
  });
  it("retains readable partial checkpoints when a host is disabled, while refusing new network reads", async () => {
    let enabled = true;
    const hostGate = {
      ...hosts,
      isEnabled: () => ({ enabled, source: "auto" as const })
    };
    const provider = base();
    provider.repositories = async () => {
      enabled = false;
      return page([repo]);
    };
    provider.organizations = vi.fn(provider.organizations);
    const { service } = setup(provider, async () => {}, hostGate);
    await service.start(scope, false);
    await service.settled();
    expect(service.read(scope)).toMatchObject({
      status: "partial",
      inventoryComplete: true,
      repos: [repo]
    });
    expect(provider.organizations).not.toHaveBeenCalled();
    await expect(service.verify(scope)).rejects.toThrow("Enable");
    await expect(service.start(scope, false)).rejects.toThrow("Enable");
    expect(service.read({ ...scope, profileId: "profile2" })).toBeNull();
    expect(service.read({ ...scope, viewerId: "U2" })).toBeNull();
    await service.cancel(scope);
    await service.clear(scope);
    expect(service.read(scope)).toBeNull();
    expect(() => service.read({ ...scope, profileId: "missing" })).toThrow(
      "profile"
    );
  });
  it("allows cancellation and deletion after a host is disabled during an in-flight collection", async () => {
    let enabled = true;
    const provider = base();
    provider.repositories = vi.fn(provider.repositories);
    const { service } = setup(
      provider,
      async (signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
        signal.throwIfAborted();
      },
      { ...hosts, isEnabled: () => ({ enabled, source: "auto" as const }) }
    );
    await service.start(scope, false);
    enabled = false;
    expect(service.read(scope)?.status).toBe("collecting");
    await service.cancel(scope);
    expect(service.read(scope)?.status).toBe("canceled");
    expect(provider.repositories).not.toHaveBeenCalled();
    await service.clear(scope);
    expect(service.read(scope)).toBeNull();
  });
  it("walks beyond 1000 PRs, dedups repeated immutable IDs, processes boundary pages before stopping", async () => {
    let pages = 0;
    const provider = base();
    provider.pulls = async (_identity, _repo, cursor) => {
      pages++;
      const index = Number(cursor ?? 0);
      const rows = Array.from({ length: 100 }, (_, i) =>
        row(`P${index * 100 + i}`)
      );
      if (index === 11)
        rows.push(row("P0"), row("old-merge", "2020-01-01T00:00:00Z"));
      return {
        ...page(rows, String(index + 1), true),
        oldestUpdatedAt:
          index === 11 ? "2026-04-10T00:00:00Z" : "2026-07-01T00:00:00Z",
        openCount: 0
      };
    };
    const { service } = setup(provider);
    await service.start(scope, false);
    await service.settled();
    const snapshot = service.read(scope)!;
    expect(pages).toBe(12);
    expect(snapshot.status).toBe("complete");
    expect(snapshot.records).toHaveLength(1200);
    expect(snapshot.repoIndex).toBe(1);
    // A count-consistent search fixture omits a valid PR; native records win.
    const indexed = snapshot.records.filter((row) => row.id !== "P1199");
    const searchMetadata = {
      totalCount: indexed.length,
      incompleteResults: false
    };
    expect(searchMetadata.totalCount).toBe(1199);
    expect(snapshot.records.some((row) => row.id === "P1199")).toBe(true);
    expect(snapshot.repos[0]).toMatchObject({ archived: true, fork: true });
  });
  it("keeps failures incomplete and resumes the exact cursor and frozen UTC cutoff", async () => {
    const provider = base();
    let failed = false;
    provider.pulls = async (_identity, _repo, cursor) => {
      if (!cursor)
        return {
          ...page([row("P1")], "NEXT", true),
          oldestUpdatedAt: "2026-06-01T00:00:00Z",
          openCount: 0
        };
      if (!failed) {
        failed = true;
        throw new Error("SSO authorization required");
      }
      return {
        ...page([row("P1"), row("P2")]),
        oldestUpdatedAt: "2026-05-01T00:00:00Z",
        openCount: 0
      };
    };
    const { db, service } = setup(provider);
    await service.start(scope, false);
    await service.settled();
    const partial = service.read(scope)!;
    expect(partial.status).toBe("partial");
    expect(partial.prCursor).toBe("NEXT");
    expect(partial.records).toHaveLength(1);
    expect(partial.refreshedAt).toBeNull();
    const restarted = new ContributionService(
      db,
      hosts,
      () => provider,
      async () => {}
    );
    await restarted.start(scope, false);
    await restarted.settled();
    const complete = restarted.read(scope)!;
    expect(complete.status).toBe("complete");
    expect(complete.records).toHaveLength(2);
    expect(complete.window).toEqual(partial.window);
    expect(complete.startedAt).toEqual(partial.startedAt);
  });
  it("isolates profile, account and host caches and clears only the requested scope", async () => {
    const { service } = setup();
    await service.start(scope, false);
    await service.settled();
    expect(service.read({ ...scope, profileId: "profile2" })).toBeNull();
    expect(service.read({ ...scope, viewerId: "U2" })).toBeNull();
    expect(service.read({ ...scope, host: "ghe.example.test" })).toBeNull();
    await service.start({ ...scope, profileId: "profile2" }, false);
    await service.settled();
    await service.clear(scope);
    expect(service.read(scope)).toBeNull();
    expect(service.read({ ...scope, profileId: "profile2" })).not.toBeNull();
  });
  it("cancels without reporting complete", async () => {
    let release!: () => void;
    const { service } = setup(base(), async (signal) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      signal.throwIfAborted();
    });
    await service.start(scope, false);
    expect(service.read(scope)?.status).toBe("collecting");
    await service.cancel(scope);
    release();
    expect(service.read(scope)?.status).toBe("canceled");
    expect(service.read(scope)?.refreshedAt).toBeNull();
  });
  it("refuses repeated pagination, active account switches and disabled hosts", async () => {
    const provider = base();
    provider.repositories = async () => page([repo], "SAME", true);
    const { db, service } = setup(provider);
    await service.start(scope, false);
    await service.settled();
    expect(service.read(scope)?.status).toBe("partial");
    expect(service.read(scope)?.inventoryComplete).toBe(false);
    provider.verify = async () => ({ ...identity, id: "U2" });
    await expect(service.start(scope, false)).rejects.toThrow("active account");
    const off = new ContributionService(
      db,
      { ...hosts, isEnabled: () => ({ enabled: false, source: "config" }) },
      () => provider
    );
    await expect(off.start(scope, false)).rejects.toThrow("Enable");
  });
  it("refuses changing inventory counts and final counts that disagree with distinct received nodes", async () => {
    for (const change of [true, false]) {
      const provider = base();
      provider.repositories = async (_identity, cursor) =>
        cursor
          ? { ...page([{ ...repo, id: "R2" }]), totalCount: change ? 3 : 4 }
          : { ...page([repo], "NEXT", true), totalCount: change ? 2 : 4 };
      const { service } = setup(provider);
      await service.start(scope, false);
      await service.settled();
      expect(service.read(scope)?.status).toBe("partial");
      expect(service.read(scope)?.inventoryComplete).toBe(false);
      expect(service.read(scope)?.repoIndex).toBe(0);
    }
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true]
  ])(
    "promotes authored discoveries on inventory resume (prior inventory page=%s, legacy checkpoint=%s)",
    async (priorPage, legacy) => {
      const provider = base();
      const overlap = { ...repo, id: "OVERLAP", path: "sample-org/overlap" };
      const external = { ...repo, id: "EXTERNAL", path: "other-org/external", owner: "other-org", ownerId: "O2" };
      const added = { ...repo, id: "ADDED", path: "sample-org/added" };
      let authorized = false;
      const inventoryCursors: (string | null)[] = [];
      provider.repositories = async (_identity, cursor) => {
        inventoryCursors.push(cursor);
        if (!authorized && (!priorPage || cursor)) throw new ContributionSsoError();
        return cursor
          ? { ...page([overlap, added]), totalCount: 3 }
          : { ...page([repo], "NEXT", true), totalCount: 3 };
      };
      provider.authored = async () => page([overlap, external].map((item): ContributionRecord => ({
        ...row(`AUTHORED_${item.id}`), repo: item, author: identity.id, mergedAt: null,
        lifecycle: {
          createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-02-01T00:00:00Z",
          closedAt: "2025-02-01T00:00:00Z", state: "CLOSED", events: [], complete: false, cursor: null
        }
      })));
      const pulls = vi.fn<ContributionProvider["pulls"]>(async (_identity, item) => ({
        ...page([{ ...row(`MERGED_${item.id}`), repo: item }]),
        oldestUpdatedAt: "2026-05-01T00:00:00Z"
      }));
      provider.pulls = pulls;
      const { db, service } = setup(provider);
      await service.start(scope, false);
      await service.settled();
      const partial = service.read(scope)!;
      expect(partial).toMatchObject({
        status: "partial", accessibleComplete: true, inventoryComplete: false,
        inventoryReceived: priorPage ? 1 : 0
      });
      expect(partial.repos.find((item) => item.id === overlap.id)?.source).toBe("authored_inventory");
      expect(partial.repoIndex).toBe(partial.repos.length);
      expect(pulls).toHaveBeenCalledTimes(priorPage ? 1 : 0);
      if (legacy) {
        const stored = db.prepare("SELECT snapshot FROM contribution_snapshots WHERE profile_id=?").get(scope.profileId) as { snapshot: string };
        const checkpoint = JSON.parse(stored.snapshot);
        delete checkpoint.inventorySeen;
        db.prepare("UPDATE contribution_snapshots SET snapshot=? WHERE profile_id=?").run(JSON.stringify(checkpoint), scope.profileId);
      }
      authorized = true;
      const restarted = new ContributionService(db, hosts, () => provider, async () => {});
      await restarted.start(scope, false);
      await restarted.settled();
      const complete = restarted.read(scope)!;
      expect(complete).toMatchObject({ status: "complete", inventoryReceived: 3, inventoryComplete: true });
      expect(complete.inventorySeen).toEqual([repo.id, overlap.id, added.id]);
      expect(complete.repos.find((item) => item.id === overlap.id)?.source).toBe("affiliated");
      expect(complete.repos.find((item) => item.id === external.id)?.source).toBe("authored_inventory");
      expect(complete.records.some((item) => item.id === `MERGED_${overlap.id}` && item.author === "U2")).toBe(true);
      expect(complete.records.find((item) => item.id === `AUTHORED_${overlap.id}`)?.repo.source).toBe("affiliated");
      expect(pulls.mock.calls.map(([, item]) => item.id)).toEqual(priorPage ? [repo.id, overlap.id, added.id] : [overlap.id, repo.id, added.id]);
      expect(inventoryCursors).toEqual(priorPage ? [null, "NEXT", "NEXT"] : [null, null, "NEXT"]);
      expect(complete.window).toEqual(partial.window);
      expect(complete.startedAt).toBe(partial.startedAt);
      expect(service.read({ ...scope, profileId: "profile2" })).toBeNull();
    }
  );
  it.each([false, true])("still rejects repeated inventory IDs (same page=%s)", async (samePage) => {
    const provider = base();
    provider.repositories = async (_identity, cursor) => samePage
      ? { ...page([repo, repo]), totalCount: 2 }
      : { ...page([repo], cursor ? null : "NEXT", !cursor), totalCount: 2 };
    const { service } = setup(provider);
    await service.start(scope, false);
    await service.settled();
    expect(service.read(scope)).toMatchObject({
      status: "partial", inventoryComplete: false, inventoryReceived: samePage ? 0 : 1,
      issues: [{ message: expect.stringContaining("Repository inventory repeated a node ID") }]
    });
  });
  it("enumerates authored external/personal activity directly, retains old closed stock, and avoids unrelated external PR walks", async () => {
    const provider = base();
    let externalWalks = 0;
    const external = {
      ...repo,
      id: "EXT",
      path: "demo-personal/notes",
      ownerId: "EXT_OWNER",
      owner: "demo-personal",
      ownerKind: "user" as const
    };
    provider.authored = async (_identity, cursor) => {
      const index = cursor ? 100 : 0;
      const nodes = Array.from(
        { length: cursor ? 1 : 100 },
        (_, i): ContributionRecord => ({
          ...row(`A${index + i}`),
          repo: external,
          author: "U1",
          mergedAt: null,
          lifecycle: {
            createdAt: "2025-01-01T12:00:00Z",
            updatedAt: "2025-02-01T12:00:00Z",
            closedAt: "2025-02-01T12:00:00Z",
            state: "CLOSED",
            complete: false,
            cursor: null,
            events: []
          }
        })
      );
      return {
        ...page(nodes, cursor ? null : "AUTH_NEXT", !cursor),
        totalCount: 101
      };
    };
    const original = provider.pulls;
    provider.pulls = async (identity, repo, cursor, signal) => {
      if (repo.id === "EXT") externalWalks++;
      return original(identity, repo, cursor, signal);
    };
    const { service } = setup(provider);
    await service.start(scope, false);
    await service.settled();
    const snapshot = service.read(scope)!;
    expect(snapshot.status).toBe("complete");
    expect(snapshot.authoredInventory.received).toBe(101);
    expect(snapshot.records.filter((row) => row.author === "U1")).toHaveLength(
      101
    );
    expect(
      snapshot.records.find((row) => row.id === "A0")?.lifecycle
    ).toMatchObject({ complete: true, frozenState: "CLOSED" });
    expect(snapshot.repos.find((repo) => repo.id === "EXT")).toMatchObject({
      source: "authored_inventory",
      ownerKind: "user"
    });
    expect(externalWalks).toBe(0);
  });
  it("checkpoints paginated lifecycle history and resumes it after a failure", async () => {
    const provider = base();
    let failed = false;
    provider.authored = async () =>
      page([
        {
          ...row("A1"),
          author: "U1",
          mergedAt: null,
          lifecycle: {
            createdAt: "2026-04-01T12:00:00Z",
            updatedAt: "2026-09-02T12:00:00Z",
            closedAt: null,
            state: "OPEN",
            events: [],
            cursor: null,
            complete: false
          }
        }
      ]);
    provider.timelines = async (_identity, rows) => {
      if (!rows[0]?.lifecycle?.cursor)
        return [
          {
            id: "A1",
            cursor: "EVENT_NEXT",
            more: true,
            filteredCount: 2,
            events: [{ id: "E1", kind: "closed", at: "2026-08-01T12:00:00Z" }]
          }
        ];
      if (!failed) {
        failed = true;
        throw new Error("Lifecycle access unavailable");
      }
      return [
        {
          id: "A1",
          cursor: null,
          more: false,
          filteredCount: 1,
          events: [{ id: "E2", kind: "reopened", at: "2026-09-02T12:00:00Z" }]
        }
      ];
    };
    const { service } = setup(provider);
    await service.start(scope, false);
    await service.settled();
    expect(service.read(scope)?.status).toBe("partial");
    expect(
      service.read(scope)?.records.find((row) => row.id === "A1")?.lifecycle
        ?.cursor
    ).toBe("EVENT_NEXT");
    await service.start(scope, false);
    await service.settled();
    expect(service.read(scope)?.status).toBe("complete");
    expect(
      service.read(scope)?.records.find((row) => row.id === "A1")?.lifecycle
        ?.events
    ).toHaveLength(2);
  });
  it("keeps a partial-today cutoff frozen when resumed on a later calendar day", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-03T16:00:00Z"));
      const provider = base();
      let fail = true;
      provider.pulls = async () => {
        if (fail) throw new Error("Access unavailable");
        return {
          ...page([
            row("P_NOW", "2026-08-03T15:59:00Z"),
            row("P_LATER", "2026-08-03T16:01:00Z")
          ]),
          oldestUpdatedAt: "2026-08-03T16:01:00Z"
        };
      };
      const currentScope = {
        ...scope,
        startDate: "2026-08-01",
        endDate: "2026-08-03"
      };
      const { service } = setup(provider);
      await service.start(currentScope, false);
      await service.settled();
      const pinned = service.read(currentScope)!.window;
      vi.setSystemTime(new Date("2026-08-04T20:00:00Z"));
      fail = false;
      await service.start(currentScope, false);
      await service.settled();
      const resumed = service.read(currentScope)!;
      expect(resumed.window).toEqual(pinned);
      expect(resumed.window.partialDay).toBe(true);
      expect(resumed.records.map((row) => row.id)).toEqual(["P_NOW"]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("refuses lifecycle exhaustion below the first filteredCount", async () => {
    const provider = base();
    provider.authored = async () =>
      page([
        {
          ...row("A1"),
          author: "U1",
          mergedAt: null,
          lifecycle: {
            createdAt: "2026-04-01T12:00:00Z",
            updatedAt: "2026-09-02T12:00:00Z",
            closedAt: null,
            state: "OPEN",
            events: [],
            cursor: null,
            complete: false
          }
        }
      ]);
    provider.timelines = async () => [
      { id: "A1", cursor: null, more: false, filteredCount: 2, events: [] }
    ];
    const { service } = setup(provider);
    await service.start(scope, false);
    await service.settled();
    expect(service.read(scope)?.status).toBe("partial");
    expect(
      service.read(scope)?.records.find((row) => row.id === "A1")?.lifecycle
        ?.complete
    ).toBe(false);
  });

  it.each([0, 1, 2])(
    "requires one terminal merge event, accepting scalar/event one-second lag (events=%s)",
    async (count) => {
      const provider = base(),
        mergedAt = "2026-10-11T03:59:59Z",
        eventAt = "2026-10-11T04:00:00Z";
      provider.authored = async () =>
        page([
          {
            ...row("A1", mergedAt),
            author: "U1",
            lifecycle: {
              createdAt: "2026-04-01T12:00:00Z",
              updatedAt: eventAt,
              closedAt: eventAt,
              state: "MERGED",
              events: [],
              cursor: null,
              complete: false
            }
          }
        ]);
      provider.timelines = async () => [
        {
          id: "A1",
          cursor: null,
          more: false,
          filteredCount: count + 1,
          events: [
            { id: "C", kind: "closed", at: eventAt },
            ...Array.from({ length: count }, (_, i) => ({
              id: `M${i}`,
              kind: "merged" as const,
              at: eventAt
            }))
          ]
        }
      ];
      const { service } = setup(provider);
      await service.start(scope, false);
      await service.settled();
      expect(service.read(scope)?.status).toBe(
        count === 1 ? "complete" : "partial"
      );
    }
  );

  it("clearing an account cancels its collector even when the screen selected a different cached range", async () => {
    const { service } = setup(base(), async (signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      signal.throwIfAborted();
    });
    const running = { ...scope, startDate: "2026-08-01" };
    await service.start(running, false);
    expect(service.read(running)?.status).toBe("collecting");
    await service.clear(scope);
    expect(service.read(scope)).toBeNull();
    expect(service.read(running)).toBeNull();
  });
});
