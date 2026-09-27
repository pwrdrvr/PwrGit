import type { Commit } from "@pwrgit/shared";
import { describe, expect, it } from "vitest";
import {
  authorInterest,
  consumeBranchPrInvalidation,
  personGraphStats
} from "./LineageGraph";

describe("active lane PR invalidation", () => {
  it("defers an invalidation observed in all scope until active is loaded", () => {
    expect(consumeBranchPrInvalidation("all", 1, 0)).toEqual({
      force: false,
      consumedGeneration: 0
    });
    expect(consumeBranchPrInvalidation("active", 1, 0)).toEqual({
      force: true,
      consumedGeneration: 1
    });
  });

  it("consumes an active invalidation exactly once", () => {
    expect(consumeBranchPrInvalidation("active", 2, 1)).toEqual({
      force: true,
      consumedGeneration: 2
    });
    expect(consumeBranchPrInvalidation("active", 2, 2)).toEqual({
      force: false,
      consumedGeneration: 2
    });
  });
});

const commit = (over: Partial<Commit> & Pick<Commit, "hash">): Commit => ({
  shortHash: over.hash.slice(0, 7),
  parents: [],
  subject: "A change",
  authorName: "Ada Lovelace",
  authorEmail: "ada@example.test",
  committedAt: "2026-09-01T12:00:00.000Z",
  isMerge: false,
  ...over
});

describe("authorInterest", () => {
  it("lists each author once, most recent first, with their newest commits", () => {
    const commits = [
      commit({ hash: "1".repeat(40), committedAt: "2026-09-01T10:00:00.000Z" }),
      commit({
        hash: "2".repeat(40),
        authorName: "Grace Hopper",
        authorEmail: "grace@example.test",
        committedAt: "2026-09-03T10:00:00.000Z"
      }),
      commit({ hash: "3".repeat(40), committedAt: "2026-09-02T10:00:00.000Z" }),
      // One person, however the address was cased.
      commit({
        hash: "4".repeat(40),
        authorEmail: "ADA@example.test",
        committedAt: "2026-08-30T10:00:00.000Z"
      }),
      commit({ hash: "5".repeat(40), committedAt: "2026-08-29T10:00:00.000Z" })
    ];

    expect(authorInterest(commits)).toEqual([
      { name: "Grace Hopper", email: "grace@example.test", commitHashes: ["2".repeat(40)] },
      {
        name: "Ada Lovelace",
        email: "ada@example.test",
        commitHashes: ["3".repeat(40), "1".repeat(40), "4".repeat(40)]
      }
    ]);
  });
});

describe("personGraphStats", () => {
  it("counts an author's loaded commits, their latest, and the tips they own", () => {
    const newest = commit({ hash: "3".repeat(40), committedAt: "2026-09-02T10:00:00.000Z" });
    const stats = personGraphStats(
      [
        commit({ hash: "1".repeat(40) }),
        commit({ hash: "2".repeat(40), authorEmail: "grace@example.test" }),
        newest
      ],
      { ["1".repeat(40)]: ["feat/lanes"], ["2".repeat(40)]: ["main"] }
    );

    expect(stats.get("ada@example.test")).toEqual({
      count: 2,
      total: 3,
      latest: newest,
      tips: ["feat/lanes"]
    });
    expect(stats.get("grace@example.test")?.tips).toEqual(["main"]);
  });
});
