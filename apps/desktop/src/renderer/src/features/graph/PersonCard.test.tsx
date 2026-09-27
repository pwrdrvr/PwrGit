import type { Commit, CommitAuthorPerson } from "@pwrgit/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PersonCard, personStatus, type PersonGraphStats } from "./PersonCard";

const latest: Commit = {
  hash: "12c93780000000000000000000000000000000ab",
  shortHash: "12c9378",
  parents: [],
  subject: "Draw the lane gutter",
  authorName: "Wilhelmina Castellanos",
  authorEmail: "wilhelmina@example.com",
  committedAt: "2026-09-26T11:54:00.000Z",
  isMerge: false
};
const stats: PersonGraphStats = { count: 14, total: 212, latest, tips: ["feat/lane-gutter"] };
const NOW = new Date("2026-09-26T12:00:00.000Z").getTime();
const PROVEN: CommitAuthorPerson = {
  state: "proven",
  identity: { login: "wcastellanos", avatarUrl: "pwrgit-avatar://thumbnail/w?v=1" },
  profileUrl: "https://github.com/wcastellanos",
  forge: "github",
  checkedAt: NOW
};

const card = (person: CommitAuthorPerson | undefined, over: {
  isMine?: boolean;
  stats?: PersonGraphStats;
} = {}): string =>
  renderToStaticMarkup(
    <PersonCard
      name={latest.authorName}
      email={latest.authorEmail}
      isMine={over.isMine ?? false}
      person={person}
      stats={over.stats ?? stats}
      now={NOW}
    />
  );

describe("PersonCard", () => {
  it("shows a proven account whole: handle, face, and the way to its page", () => {
    const markup = card(PROVEN);
    expect(markup).toContain(">@wcastellanos<");
    expect(markup).toContain('src="pwrgit-avatar://thumbnail/w?v=1"');
    expect(markup).toContain("GitHub account, proven by a commit");
    expect(markup).toContain("Open on GitHub");
    expect(markup).toContain("Co-author line");
    expect(markup).toContain("14 of 212 shown");
    expect(markup).toContain("6 minutes ago · 12c9378");
    expect(markup).toContain("feat/lane-gutter");
  });

  it("never shows a handle, face or profile link without the proof", () => {
    for (const person of [
      undefined,
      { state: "pending", forge: "gitlab" },
      { state: "none", forge: "github", checkedAt: NOW },
      { state: "unsupported" },
      // A stray identity on an unproven person is still not shown.
      { state: "none", identity: { login: "someone-else" }, profileUrl: "https://github.com/x" }
    ] satisfies Array<CommitAuthorPerson | undefined>) {
      const markup = card(person);
      expect(markup).not.toContain("person-card__login");
      expect(markup).not.toContain("Open on");
      expect(markup).not.toContain("commit-byline__avatar-image");
      expect(markup).not.toContain("person-card__avatar-image");
      expect(markup).toContain("is-muted");
    }
  });

  it("marks your own card, and offers no co-author line for yourself", () => {
    const markup = card(PROVEN, { isMine: true });
    expect(markup).toContain("Author · you");
    expect(markup).not.toContain("Co-author line");
    expect(markup).toContain("Open on GitHub");
    expect(card({ state: "pending" }, { isMine: true })).not.toContain("person-card__actions");
  });

  it("folds tips past two into a count", () => {
    const markup = card(PROVEN, {
      stats: { ...stats, tips: ["feat/a", "feat/b", "feat/c", "feat/d"] }
    });
    expect(markup).toContain("Tips of");
    expect(markup).toContain("feat/a, feat/b +2");
  });

  it("says in one line what the forge knows", () => {
    expect(personStatus({ state: "none", forge: "gitlab" }).text).toBe(
      "GitLab links these commits to no account"
    );
    expect(personStatus({ state: "pending", forge: "github" }).text).toBe(
      "Not checked with GitHub yet"
    );
    expect(personStatus({ state: "unsupported", forge: "gitcafe" }).text).toBe(
      "GitCafe can't link commits to accounts"
    );
    expect(personStatus({ state: "unsupported" }).text).toBe(
      "This repository's remote has no accounts to check"
    );
  });
});
