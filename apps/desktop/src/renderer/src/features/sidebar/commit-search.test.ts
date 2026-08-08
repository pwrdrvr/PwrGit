import type { Commit } from "@pwrgit/shared";
import { describe, expect, it } from "vitest";
import { commitHashQuery, searchCommits } from "./commit-search";

const commit = (
  hash: string,
  subject: string,
  authorName = "Harold",
  authorEmail = "harold@example.com"
): Commit => ({
  hash: hash.padEnd(40, "0"),
  shortHash: hash.padEnd(7, "0"),
  parents: [],
  subject,
  authorName,
  authorEmail,
  committedAt: "2026-08-06T12:00:00.000Z",
  isMerge: false
});

const commits = [
  commit("a1", "fix(desktop): remote terminals for pinned threads"),
  commit("b2", "docs: explain terminal setup"),
  commit("c3", "feat: searchable history", "Renée", "renee@example.com")
];

describe("searchCommits", () => {
  it("matches commit subjects without case or punctuation sensitivity", () => {
    expect(searchCommits(commits, "REMOTE TERMINALS")).toEqual([commits[0]]);
    expect(searchCommits(commits, "desktop terminals")).toEqual([commits[0]]);
  });

  it("matches full and abbreviated hash prefixes", () => {
    expect(searchCommits(commits, "b200")).toEqual([commits[1]]);
  });

  it("matches author identity with diacritics removed", () => {
    expect(searchCommits(commits, "renee")).toEqual([commits[2]]);
    expect(searchCommits(commits, "renee@example.com")).toEqual([commits[2]]);
  });

  it("preserves non-Latin letters in subjects and author names", () => {
    const unicodeCommits = [
      commit("d4", "исправление: поиск коммитов"),
      commit("e5", "検索履歴を追加", "李雷", "lilei@example.com"),
      commit("f6", "إصلاح البحث")
    ];
    expect(searchCommits(unicodeCommits, "поиск коммитов")).toEqual([
      unicodeCommits[0]
    ]);
    expect(searchCommits(unicodeCommits, "李雷")).toEqual([
      unicodeCommits[1]
    ]);
    expect(searchCommits(unicodeCommits, "إصلاح")).toEqual([
      unicodeCommits[2]
    ]);
  });

  it("does not populate commit results until a query is entered", () => {
    expect(searchCommits(commits, "  ")).toEqual([]);
  });

  it("ranks hash and stronger subject matches first", () => {
    const ranked = [
      commit("f00", "terminal tools"),
      commit("d00", "add terminal"),
      commit("e00", "terminal")
    ];
    expect(searchCommits(ranked, "terminal")).toEqual([
      ranked[0],
      ranked[2],
      ranked[1]
    ]);
  });
});

describe("commitHashQuery", () => {
  it("accepts short and full SHAs regardless of case", () => {
    expect(commitHashQuery(" B200 ")).toBe("b200");
    expect(commitHashQuery("A".repeat(40))).toBe("a".repeat(40));
  });

  it("rejects ordinary text and implausibly short IDs", () => {
    expect(commitHashQuery("remote terminals")).toBeNull();
    expect(commitHashQuery("abc")).toBeNull();
  });
});
