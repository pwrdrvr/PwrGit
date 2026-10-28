// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { Repo } from "@pwrgit/shared";
import { nextBulkSyncRun, type BulkSyncRun } from "./useBulkSyncRun";
import {
  BULK_SYNC_VIEW_KEY,
  FETCH_INTERVAL_KEY,
  FETCH_SCOPE_KEY,
  fetchIntervalLabel,
  readBulkSyncView,
  readFetchInterval,
  readFetchScope,
  readSyncVerb,
  writeBulkSyncView,
  writeFetchInterval,
  writeFetchScope,
  writeSyncVerb
} from "./bulk-sync-prefs";

const repo = (id: string): Repo => ({
  id,
  name: id,
  path: `/repos/${id}`,
  profileId: "p",
  pinned: false,
  worktrees: []
});
const all = [repo("a"), repo("b"), repo("c")];
const recent = [repo("b")];

const request = (over: Partial<Parameters<typeof nextBulkSyncRun>[1]> = {}) => ({
  mode: "fetch" as const,
  scope: "all" as const,
  auto: false,
  repos: all,
  recentRepos: recent,
  remembered: null,
  key: 7,
  ...over
});

describe("nextBulkSyncRun", () => {
  it("opens a first-ever run as the dialog that minimises itself", () => {
    const run = nextBulkSyncRun(null, request());
    expect(run).toMatchObject({ view: "dialog", autoMinimize: true, key: 7 });
    expect(run?.repoIds).toBeUndefined();
  });

  it("opens straight to the remembered view, with no lesson", () => {
    expect(nextBulkSyncRun(null, request({ remembered: "toast" }))).toMatchObject(
      { view: "toast", autoMinimize: false }
    );
    expect(nextBulkSyncRun(null, request({ remembered: "dialog" }))).toMatchObject(
      { view: "dialog", autoMinimize: false }
    );
  });

  it("fetches recent as the Focused list's ids", () => {
    const run = nextBulkSyncRun(null, request({ scope: "recent" }));
    expect(run?.repoIds).toEqual(["b"]);
    expect(run?.repos.map((r) => r.id)).toEqual(["b"]);
  });

  it("pulls recent as the Focused list's ids too", () => {
    const run = nextBulkSyncRun(null, request({ mode: "soft-pull", scope: "recent" }));
    expect(run?.scope).toBe("recent");
    expect(run?.repoIds).toEqual(["b"]);
  });

  it("starts nothing for an empty scope", () => {
    expect(nextBulkSyncRun(null, request({ scope: "recent", recentRepos: [] }))).toBeNull();
  });

  it("runs a timed fetch hidden", () => {
    expect(nextBulkSyncRun(null, request({ auto: true, remembered: null }))).toMatchObject({
      view: "hidden",
      autoMinimize: false,
      auto: true
    });
  });

  it("never doubles a live run: a click shows a hidden one, a tick leaves it", () => {
    const hidden = nextBulkSyncRun(null, request({ auto: true })) as BulkSyncRun;
    expect(nextBulkSyncRun(hidden, request({ auto: true, key: 8 }))).toBe(hidden);
    expect(
      nextBulkSyncRun(hidden, request({ remembered: "toast", key: 8 }))
    ).toMatchObject({ key: hidden.key, view: "toast" });
    const shown = { ...hidden, view: "dialog" as const };
    expect(nextBulkSyncRun(shown, request({ key: 8 }))).toBe(shown);
  });

  it("replaces a finished run", () => {
    const done = { ...(nextBulkSyncRun(null, request()) as BulkSyncRun), finished: true };
    expect(nextBulkSyncRun(done, request({ key: 9 }))?.key).toBe(9);
  });
});

describe("bulk-sync prefs", () => {
  afterEach(() => window.localStorage.clear());

  it("defaults, and falls back on values it does not know", () => {
    expect(readFetchScope()).toBe("all");
    expect(readSyncVerb()).toBe("fetch");
    expect(readFetchInterval()).toBe(0);
    expect(readBulkSyncView()).toBeNull();
    window.localStorage.setItem(FETCH_SCOPE_KEY, "everything");
    window.localStorage.setItem(FETCH_INTERVAL_KEY, "7");
    window.localStorage.setItem(BULK_SYNC_VIEW_KEY, "modal");
    expect(readFetchScope()).toBe("all");
    expect(readFetchInterval()).toBe(0);
    expect(readBulkSyncView()).toBeNull();
  });

  it("round-trips what is written", () => {
    writeFetchScope("recent");
    writeSyncVerb("pull");
    writeFetchInterval(15);
    writeBulkSyncView("toast");
    expect(readFetchScope()).toBe("recent");
    expect(readSyncVerb()).toBe("pull");
    expect(readFetchInterval()).toBe(15);
    expect(readBulkSyncView()).toBe("toast");
  });

  it("labels each interval", () => {
    expect([0, 1, 5, 15, 60].map((m) => fetchIntervalLabel(m as 0))).toEqual([
      "Off",
      "Every minute",
      "Every 5 minutes",
      "Every 15 minutes",
      "Every hour"
    ]);
  });
});
