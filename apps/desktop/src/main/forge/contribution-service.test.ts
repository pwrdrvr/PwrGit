import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import { ContributionService, type ContributionScope } from "./contribution-service";
import type { ContributionProvider } from "./github/contribution-provider";
import type { ContributionRepo, ContributionRecord } from "@pwrgit/shared";

const identity = { id: "U1", login: "sample-user", host: "github.com" };
const repo: ContributionRepo = { id: "R1", path: "sample-org/widget", owner: "sample-org", ownerId: "O1", ownerKind: "organization", archived: true, fork: true, visibility: "PRIVATE" };
const scope: ContributionScope = { profileId: "profile1", host: "github.com", viewerId: "U1", startDate: "2026-04-11", endDate: "2026-10-10", timezone: "America/New_York" };
const row = (id: string, mergedAt = "2026-05-01T04:00:00Z"): ContributionRecord => ({ id, repo, number: 1, mergedAt, mergedBy: "U1", author: "U2" });
const page = <T>(nodes: T[], cursor: string | null = null, more = false) => ({ nodes, cursor, more, totalCount: nodes.length });
const hosts = { kindFor: () => ({ kind: "github" as const, source: "auto" as const }), isEnabled: () => ({ enabled: true, source: "auto" as const }) };
const databases: DB[] = [];
const base = (): ContributionProvider => ({
  verify: async () => identity,
  repositories: async () => page([repo]), organizations: async () => page(["sample-org"]),
  pulls: async () => ({ ...page([row("P1")]), oldestUpdatedAt: "2026-05-01T04:00:00Z", openCount: 0 }),
  authored: async () => page([]), timelines: async () => []
});
function setup(provider = base(), pause: (signal: AbortSignal) => Promise<void> = async () => {}) {
  const db = openDatabase(":memory:"); databases.push(db);
  db.prepare("INSERT INTO profiles(id,name,email) VALUES(?,?,?)").run("profile1", "Sample", "sample@example.test");
  db.prepare("INSERT INTO profiles(id,name,email) VALUES(?,?,?)").run("profile2", "Other", "other@example.test");
  const service = new ContributionService(db, hosts, () => provider, pause);
  return { db, service };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
describe("local contribution checkpoints", () => {
  it("walks beyond 1000 PRs, dedups repeated immutable IDs, processes boundary pages before stopping", async () => {
    let pages = 0;
    const provider = base();
    provider.pulls = async (_identity, _repo, cursor) => {
      pages++;
      const index = Number(cursor ?? 0);
      const rows = Array.from({ length: 100 }, (_, i) => row(`P${index * 100 + i}`));
      if (index === 11) rows.push(row("P0"), row("old-merge", "2020-01-01T00:00:00Z"));
      return { ...page(rows, String(index + 1), true), oldestUpdatedAt: index === 11 ? "2026-04-10T00:00:00Z" : "2026-07-01T00:00:00Z", openCount: 0 };
    };
    const { service } = setup(provider);
    await service.start(scope, false); await service.settled();
    const snapshot = service.read(scope)!;
    expect(pages).toBe(12); expect(snapshot.status).toBe("complete");
    expect(snapshot.records).toHaveLength(1200); expect(snapshot.repoIndex).toBe(1);
    // A count-consistent search fixture omits a valid PR; native records win.
    const indexed = snapshot.records.filter(row => row.id !== "P1199");
    const searchMetadata = { totalCount: indexed.length, incompleteResults: false };
    expect(searchMetadata.totalCount).toBe(1199);
    expect(snapshot.records.some(row => row.id === "P1199")).toBe(true);
    expect(snapshot.repos[0]).toMatchObject({ archived: true, fork: true });
  });
  it("keeps failures incomplete and resumes the exact cursor and frozen UTC cutoff", async () => {
    const provider = base(); let failed = false;
    provider.pulls = async (_identity, _repo, cursor) => {
      if (!cursor) return { ...page([row("P1")], "NEXT", true), oldestUpdatedAt: "2026-06-01T00:00:00Z", openCount: 0 };
      if (!failed) { failed = true; throw new Error("SSO authorization required"); }
      return { ...page([row("P1"), row("P2")]), oldestUpdatedAt: "2026-05-01T00:00:00Z", openCount: 0 };
    };
    const { db, service } = setup(provider);
    await service.start(scope, false); await service.settled();
    const partial = service.read(scope)!;
    expect(partial.status).toBe("partial"); expect(partial.prCursor).toBe("NEXT");
    expect(partial.records).toHaveLength(1); expect(partial.refreshedAt).toBeNull();
    const restarted = new ContributionService(db, hosts, () => provider, async () => {});
    await restarted.start(scope, false); await restarted.settled();
    const complete = restarted.read(scope)!;
    expect(complete.status).toBe("complete"); expect(complete.records).toHaveLength(2);
    expect(complete.window).toEqual(partial.window); expect(complete.startedAt).toEqual(partial.startedAt);
  });
  it("isolates profile, account and host caches and clears only the requested scope", async () => {
    const { service } = setup();
    await service.start(scope, false); await service.settled();
    expect(service.read({ ...scope, profileId: "profile2" })).toBeNull();
    expect(service.read({ ...scope, viewerId: "U2" })).toBeNull();
    expect(service.read({ ...scope, host: "ghe.example.test" })).toBeNull();
    await service.start({ ...scope, profileId: "profile2" }, false); await service.settled();
    await service.clear(scope);
    expect(service.read(scope)).toBeNull(); expect(service.read({ ...scope, profileId: "profile2" })).not.toBeNull();
  });
  it("cancels without reporting complete", async () => {
    let release!: () => void;
    const { service } = setup(base(), async signal => {
      await new Promise<void>(resolve => { release = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); });
      signal.throwIfAborted();
    });
    await service.start(scope, false);
    expect(service.read(scope)?.status).toBe("collecting");
    await service.cancel(scope); release();
    expect(service.read(scope)?.status).toBe("canceled"); expect(service.read(scope)?.refreshedAt).toBeNull();
  });
  it("refuses repeated pagination, active account switches and disabled hosts", async () => {
    const provider = base();
    provider.repositories = async () => page([repo], "SAME", true);
    const { db, service } = setup(provider);
    await service.start(scope, false); await service.settled();
    expect(service.read(scope)?.status).toBe("partial"); expect(service.read(scope)?.inventoryComplete).toBe(false);
    provider.verify = async () => ({ ...identity, id: "U2" });
    await expect(service.start(scope, false)).rejects.toThrow("active account");
    const off = new ContributionService(db, { ...hosts, isEnabled: () => ({ enabled: false, source: "config" }) }, () => provider);
    await expect(off.start(scope, false)).rejects.toThrow("Enable");
  });
  it("refuses changing inventory counts and final counts that disagree with distinct received nodes", async () => {
    for (const change of [true, false]) {
      const provider = base();
      provider.repositories = async (_identity, cursor) => cursor
        ? { ...page([{ ...repo, id: "R2" }]), totalCount: change ? 3 : 4 }
        : { ...page([repo], "NEXT", true), totalCount: change ? 2 : 4 };
      const { service } = setup(provider);
      await service.start(scope, false); await service.settled();
      expect(service.read(scope)?.status).toBe("partial");
      expect(service.read(scope)?.inventoryComplete).toBe(false);
      expect(service.read(scope)?.repoIndex).toBe(0);
    }
  });
  it("enumerates authored external/personal activity directly, retains old closed stock, and avoids unrelated external PR walks", async () => {
    const provider = base(); let externalWalks = 0;
    const external = { ...repo, id: "EXT", path: "demo-personal/notes", ownerId: "EXT_OWNER", owner: "demo-personal", ownerKind: "user" as const };
    provider.authored = async (_identity, cursor) => {
      const index = cursor ? 100 : 0;
      const nodes = Array.from({ length: cursor ? 1 : 100 }, (_, i): ContributionRecord => ({ ...row(`A${index + i}`), repo: external, author: "U1", mergedAt: null, lifecycle: { createdAt: "2025-01-01T12:00:00Z", updatedAt: "2025-02-01T12:00:00Z", closedAt: "2025-02-01T12:00:00Z", state: "CLOSED", complete: false, cursor: null, events: [] } }));
      return { ...page(nodes, cursor ? null : "AUTH_NEXT", !cursor), totalCount: 101 };
    };
    const original = provider.pulls;
    provider.pulls = async (identity, repo, cursor, signal) => { if (repo.id === "EXT") externalWalks++; return original(identity, repo, cursor, signal); };
    const { service } = setup(provider);
    await service.start(scope, false); await service.settled();
    const snapshot = service.read(scope)!;
    expect(snapshot.status).toBe("complete"); expect(snapshot.authoredInventory.received).toBe(101);
    expect(snapshot.records.filter(row => row.author === "U1")).toHaveLength(101);
    expect(snapshot.records.find(row => row.id === "A0")?.lifecycle).toMatchObject({ complete: true, frozenState: "CLOSED" });
    expect(snapshot.repos.find(repo => repo.id === "EXT")).toMatchObject({ source: "authored_inventory", ownerKind: "user" });
    expect(externalWalks).toBe(0);
  });
  it("checkpoints paginated lifecycle history and resumes it after a failure", async () => {
    const provider = base(); let failed = false;
    provider.authored = async () => page([{ ...row("A1"), author: "U1", mergedAt: null, lifecycle: { createdAt: "2026-04-01T12:00:00Z", updatedAt: "2026-09-02T12:00:00Z", closedAt: null, state: "OPEN", events: [], cursor: null, complete: false } }]);
    provider.timelines = async (_identity, rows) => {
      if (!rows[0]?.lifecycle?.cursor) return [{ id: "A1", cursor: "EVENT_NEXT", more: true, filteredCount: 2, events: [{ id: "E1", kind: "closed", at: "2026-08-01T12:00:00Z" }] }];
      if (!failed) { failed = true; throw new Error("Lifecycle access unavailable"); }
      return [{ id: "A1", cursor: null, more: false, filteredCount: 1, events: [{ id: "E2", kind: "reopened", at: "2026-09-02T12:00:00Z" }] }];
    };
    const { service } = setup(provider);
    await service.start(scope, false); await service.settled();
    expect(service.read(scope)?.status).toBe("partial");
    expect(service.read(scope)?.records.find(row => row.id === "A1")?.lifecycle?.cursor).toBe("EVENT_NEXT");
    await service.start(scope, false); await service.settled();
    expect(service.read(scope)?.status).toBe("complete");
    expect(service.read(scope)?.records.find(row => row.id === "A1")?.lifecycle?.events).toHaveLength(2);
  });
  it("keeps a partial-today cutoff frozen when resumed on a later calendar day", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-03T16:00:00Z"));
      const provider = base(); let fail = true;
      provider.pulls = async () => { if (fail) throw new Error("Access unavailable"); return { ...page([row("P_NOW", "2026-08-03T15:59:00Z"), row("P_LATER", "2026-08-03T16:01:00Z")]), oldestUpdatedAt: "2026-08-03T16:01:00Z" }; };
      const currentScope = { ...scope, startDate: "2026-08-01", endDate: "2026-08-03" };
      const { service } = setup(provider);
      await service.start(currentScope, false); await service.settled();
      const pinned = service.read(currentScope)!.window;
      vi.setSystemTime(new Date("2026-08-04T20:00:00Z")); fail = false;
      await service.start(currentScope, false); await service.settled();
      const resumed = service.read(currentScope)!;
      expect(resumed.window).toEqual(pinned); expect(resumed.window.partialDay).toBe(true);
      expect(resumed.records.map(row => row.id)).toEqual(["P_NOW"]);
    } finally { vi.useRealTimers(); }
  });
  it("refuses lifecycle exhaustion below the first filteredCount", async () => {
    const provider = base();
    provider.authored = async () => page([{ ...row("A1"), author: "U1", mergedAt: null, lifecycle: { createdAt: "2026-04-01T12:00:00Z", updatedAt: "2026-09-02T12:00:00Z", closedAt: null, state: "OPEN", events: [], cursor: null, complete: false } }]);
    provider.timelines = async () => [{ id: "A1", cursor: null, more: false, filteredCount: 2, events: [] }];
    const { service } = setup(provider);
    await service.start(scope, false); await service.settled();
    expect(service.read(scope)?.status).toBe("partial");
    expect(service.read(scope)?.records.find(row => row.id === "A1")?.lifecycle?.complete).toBe(false);
  });

  it.each([0, 1, 2])("requires one terminal merge event, accepting scalar/event one-second lag (events=%s)", async count => {
    const provider = base(), mergedAt = "2026-10-11T03:59:59Z", eventAt = "2026-10-11T04:00:00Z";
    provider.authored = async () => page([{ ...row("A1", mergedAt), author: "U1", lifecycle: { createdAt: "2026-04-01T12:00:00Z", updatedAt: eventAt, closedAt: eventAt, state: "MERGED", events: [], cursor: null, complete: false } }]);
    provider.timelines = async () => [{ id: "A1", cursor: null, more: false, filteredCount: count + 1, events: [{ id: "C", kind: "closed", at: eventAt }, ...Array.from({ length: count }, (_, i) => ({ id: `M${i}`, kind: "merged" as const, at: eventAt }))] }];
    const { service } = setup(provider);
    await service.start(scope, false); await service.settled();
    expect(service.read(scope)?.status).toBe(count === 1 ? "complete" : "partial");
  });

  it("clearing an account cancels its collector even when the screen selected a different cached range", async () => {
    const { service } = setup(base(), async signal => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      signal.throwIfAborted();
    });
    const running = { ...scope, startDate: "2026-08-01" };
    await service.start(running, false);
    expect(service.read(running)?.status).toBe("collecting");
    await service.clear(scope);
    expect(service.read(scope)).toBeNull(); expect(service.read(running)).toBeNull();
  });

});
