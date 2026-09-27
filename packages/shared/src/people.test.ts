import { describe, expect, it } from "vitest";
import {
  COMMIT_AUTHOR_INTEREST_COMMITS,
  commitAuthorInterest,
  mergeCommitAuthorPeople
} from "./people";
import type { CommitAuthorPerson } from "./types";

const proven = (checkedAt: number, avatarUrl?: string): CommitAuthorPerson => ({
  state: "proven",
  identity: { login: "ada", ...(avatarUrl === undefined ? {} : { avatarUrl }) },
  forge: "github",
  checkedAt
});

describe("commitAuthorInterest", () => {
  it("keeps the given order, one entry per address, and caps each author's commits", () => {
    const commits = ["1", "2", "3", "4", "5"].map((digit, index) => ({
      hash: digit.repeat(40),
      authorName: index === 1 ? "Grace Hopper" : "Ada Lovelace",
      authorEmail: index === 1 ? "grace@example.test" : index === 2 ? "ADA@example.test " : "ada@example.test"
    }));
    commits.push({ hash: "6".repeat(40), authorName: "No Address", authorEmail: "  " });

    const authors = commitAuthorInterest(commits);
    expect(authors.map((author) => author.email)).toEqual([
      "ada@example.test",
      "grace@example.test"
    ]);
    expect(authors[0]?.commitHashes).toEqual(
      ["1", "3", "4"].map((digit) => digit.repeat(40))
    );
    expect(authors[0]?.commitHashes).toHaveLength(COMMIT_AUTHOR_INTEREST_COMMITS);
  });
});

describe("mergeCommitAuthorPeople", () => {
  it("keeps a later-checked answer when an older one lands after it", () => {
    const current = { "ada@example.test": proven(200) };
    expect(mergeCommitAuthorPeople(current, { "ada@example.test": proven(100) })).toBe(current);
  });

  it("never lets pending erase an answer", () => {
    const current: Record<string, CommitAuthorPerson> = {
      "ada@example.test": proven(100),
      "grace@example.test": { state: "none", forge: "github", checkedAt: 100 }
    };
    expect(mergeCommitAuthorPeople(current, {
      "ada@example.test": { state: "pending", forge: "github" },
      "grace@example.test": { state: "pending", forge: "github" }
    })).toBe(current);
  });

  it("takes newer answers, same-age refreshes, and people it has not seen", () => {
    const current = { "ada@example.test": proven(100, "pwrgit-avatar://thumbnail/a?v=1") };
    const refreshed = proven(100, "pwrgit-avatar://thumbnail/a?v=2");
    const grace: CommitAuthorPerson = { state: "pending", forge: "github" };
    expect(mergeCommitAuthorPeople(current, {
      "ada@example.test": refreshed,
      "grace@example.test": grace
    })).toEqual({ "ada@example.test": refreshed, "grace@example.test": grace });

    const unlinked: CommitAuthorPerson = { state: "none", forge: "github", checkedAt: 300 };
    expect(mergeCommitAuthorPeople(current, { "ada@example.test": unlinked })).toEqual({
      "ada@example.test": unlinked
    });
  });
});
