import type { ChangeRequestEntry, ChangeRequestView } from "@pwrgit/shared";
import { describe, expect, it } from "vitest";
import { holderPhrase, primaryVerb, provenanceOf } from "./provenance";

const entry = (location: ChangeRequestEntry["location"], headOid?: string): ChangeRequestEntry => ({
  pr: {
    number: 42,
    url: "https://example.test/acme/orbit/pull/42",
    title: "Plan view",
    state: "open",
    isDraft: false,
    forge: "github",
    ...(headOid === undefined ? {} : { headOid })
  },
  location,
  remote: "origin",
  forgeRepo: "github.com/acme/orbit"
});

const LOCAL = "1111111aaaaaaa";
const FORGE = "2222222bbbbbbb";
const wt = entry({ kind: "worktree", branch: "feat/plan", worktreeId: "wt-9" });
const worktreeHead = {
  oid: LOCAL,
  holder: { kind: "worktree" as const, branch: "feat/plan", worktreeId: "wt-9" }
};
const forgeHead = { oid: FORGE, holder: { kind: "remote" as const, name: "origin/feat/plan" } };

const ready = (
  relation: Extract<ChangeRequestView, { state: "ready" }>["relation"],
  shown: "local" | "forge",
  overrides: Partial<Extract<ChangeRequestView, { state: "ready" }>> = {}
): ChangeRequestView => ({
  state: "ready",
  entry: wt,
  local: worktreeHead,
  forge: forgeHead,
  relation,
  head: shown === "local" ? worktreeHead : forgeHead,
  shown,
  base: { name: "origin/main", oid: "base", mergeBase: "mb" },
  commits: [],
  commitsTruncated: false,
  patch: "",
  ...overrides
});

describe("holderPhrase", () => {
  it("names where a head lives the way a person would", () => {
    expect(holderPhrase(worktreeHead)).toBe("Worktree feat/plan");
    expect(holderPhrase({ oid: LOCAL, holder: { kind: "local", branch: "feat/plan" } })).toBe(
      "Local branch feat/plan"
    );
    expect(holderPhrase(forgeHead)).toBe("origin/feat/plan");
    expect(
      holderPhrase({
        oid: FORGE,
        holder: { kind: "fetched", source: "refs/pull/42/head", remote: "upstream" }
      })
    ).toBe("pull/42/head, fetched from upstream");
  });
});

describe("provenanceOf", () => {
  it("says a head that is not here can be fetched, and that nothing gets checked out", () => {
    const answer = provenanceOf({ state: "needsFetch", entry: wt, what: "origin/fix/audit" });
    expect(answer.tone).toBe("muted");
    expect(answer.text).toContain("origin/fix/audit is not in this checkout yet");
    expect(answer.fetch).toBe("Fetch");
  });

  it("offers to try again when git could not answer", () => {
    expect(provenanceOf({ state: "unavailable", entry: wt, message: "Gone." })).toEqual({
      tone: "bad",
      text: "Gone.",
      fetch: "Try again"
    });
  });

  it("is quiet when the head shown is the forge's", () => {
    const answer = provenanceOf(ready({ kind: "same" }, "local"));
    expect(answer).toEqual({
      tone: "ok",
      text: "Worktree feat/plan holds 1111111, the head GitHub shows."
    });
  });

  it("warns that unpushed work is shown, and offers the forge's head", () => {
    const answer = provenanceOf(ready({ kind: "ahead", count: 2 }, "local"));
    expect(answer.tone).toBe("warn");
    expect(answer.text).toBe(
      "Worktree feat/plan holds 1111111: 2 commits ahead of what GitHub shows, unpushed."
    );
    expect(answer.toggle).toEqual({ label: "Show GitHub's head", show: "forge" });

    expect(provenanceOf(ready({ kind: "ahead", count: 1 }, "forge")).toggle).toEqual({
      label: "Show yours",
      show: "local"
    });
  });

  it("shows the forge's head over a branch behind it, and names the branch", () => {
    const answer = provenanceOf(ready({ kind: "behind", count: 3 }, "forge"));
    expect(answer.text).toBe(
      "Showing GitHub's head, 2222222. Worktree feat/plan is 3 commits behind."
    );
    expect(answer.toggle).toEqual({ label: "Show yours", show: "local" });
  });

  it("gives both counts when the two have diverged", () => {
    const answer = provenanceOf(ready({ kind: "diverged", ahead: 1, behind: 4 }, "local"));
    expect(answer.text).toContain("have diverged: 1 ahead, 4 behind");
    expect(answer.toggle?.show).toBe("forge");
  });

  it("offers to fetch the forge's head when its commit is not here", () => {
    const answer = provenanceOf(
      ready({ kind: "unknown" }, "local", {
        entry: entry({ kind: "worktree", branch: "feat/plan", worktreeId: "wt-9" }, FORGE),
        forge: null
      })
    );
    expect(answer.text).toBe(
      "Worktree feat/plan holds 1111111. GitHub shows 2222222, which is not fetched here."
    );
    expect(answer.toggle).toEqual({ label: "Fetch GitHub's head", show: "forge" });
  });
});

describe("primaryVerb", () => {
  it("goes to a worktree that holds the head, offers one otherwise, and nothing when it cannot", () => {
    expect(primaryVerb(wt)).toEqual({ kind: "goto", worktreeId: "wt-9" });
    expect(primaryVerb(entry({ kind: "unfetched", branch: "fix/a", remote: "origin" }))).toEqual({
      kind: "create"
    });
    const fork = {
      kind: "fork" as const,
      branch: "patch-1",
      headRepoPath: "someone/orbit",
      localBranch: "pr-42",
      remote: "origin"
    };
    expect(primaryVerb(entry({ ...fork, fetchable: true }))).toEqual({ kind: "create" });
    expect(primaryVerb(entry({ ...fork, fetchable: false }))).toBeNull();
    expect(primaryVerb(entry({ kind: "missing", branch: null }))).toBeNull();
  });
});
