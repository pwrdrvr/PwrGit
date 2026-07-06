import { describe, expect, it } from "vitest";
import type { Commit } from "@pwrgit/shared";
import { decorateCommits, filterOnlyMe, shortWhen } from "./graph-view";

function commit(partial: Partial<Commit> & { hash: string }): Commit {
  return {
    shortHash: partial.hash.slice(0, 7),
    parents: [],
    subject: "s",
    authorName: "n",
    authorEmail: "n@x.com",
    committedAt: "2026-01-01T00:00:00Z",
    isMerge: false,
    ...partial
  };
}

describe("decorateCommits / filterOnlyMe", () => {
  const commits = [
    commit({ hash: "a", authorEmail: "me@x.com" }),
    commit({ hash: "b", authorEmail: "other@x.com" }),
    commit({ hash: "root", authorEmail: "other@x.com" })
  ];

  it("marks isMine (case-insensitive) and isBase", () => {
    const rows = decorateCommits(commits, "ME@x.com", "root");
    expect(rows[0]?.isMine).toBe(true);
    expect(rows[1]?.isMine).toBe(false);
    expect(rows[2]?.isBase).toBe(true);
  });

  it("Only-me keeps mine + the branch root, hiding others", () => {
    const rows = decorateCommits(commits, "me@x.com", "root");
    const visible = filterOnlyMe(rows, true);
    expect(visible.map((r) => r.hash)).toEqual(["a", "root"]);
    expect(filterOnlyMe(rows, false)).toHaveLength(3);
  });
});

describe("shortWhen", () => {
  const base = new Date("2026-06-01T00:00:00Z").getTime();
  it("formats recent and older times", () => {
    expect(shortWhen("2026-06-01T00:00:00Z", base)).toBe("just now");
    expect(shortWhen("2026-05-31T22:00:00Z", base)).toBe("2h");
    expect(shortWhen("2026-05-27T00:00:00Z", base)).toBe("5d");
    expect(shortWhen("2026-05-18T00:00:00Z", base)).toBe("2w");
  });
});
