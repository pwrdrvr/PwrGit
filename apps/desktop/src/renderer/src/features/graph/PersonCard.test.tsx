import type { Commit, CommitAuthorPerson } from "@pwrgit/shared";
import { renderToStaticMarkup } from "react-dom/server";
import fc from "fast-check";
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
const LINKED: CommitAuthorPerson = {
  state: "linked",
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
  it("shows a linked account whole: handle, face, and the way to its page", () => {
    const markup = card(LINKED);
    expect(markup).toContain(">@wcastellanos<");
    expect(markup).toContain('src="pwrgit-avatar://thumbnail/w?v=1"');
    expect(markup).toContain("Matched to this GitHub account, not verified");
    expect(markup).toContain("person-card__status is-linked");
    expect(markup).toContain("Open on GitHub");
    expect(markup).toContain("Co-author line");
    expect(markup).toContain("14 of 212 shown");
    expect(markup).toContain("6 minutes ago · 12c9378");
    expect(markup).toContain("feat/lane-gutter");
  });

  it("never shows a handle, face or profile link without a forge match", () => {
    for (const person of [
      undefined,
      { state: "pending", forge: "gitlab" },
      { state: "none", forge: "github", checkedAt: NOW },
      { state: "unsupported" },
      // A stray identity on an unlinked person is still not shown.
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
    const markup = card(LINKED, { isMine: true });
    expect(markup).toContain("Author · you");
    expect(markup).not.toContain("Co-author line");
    expect(markup).toContain("Open on GitHub");
    expect(card({ state: "pending" }, { isMine: true })).not.toContain("person-card__actions");
  });

  it("draws no actions row when no action applies", () => {
    const html = renderToStaticMarkup(
      <PersonCard
        name="Build Bot"
        email=""
        isMine={false}
        person={{ state: "none", forge: "github", checkedAt: NOW }}
        stats={stats}
        now={NOW}
      />
    );
    expect(html).not.toContain("person-card__actions");
    expect(html).not.toContain("Co-author line");
  });

  it("folds tips past two into a count", () => {
    const markup = card(LINKED, {
      stats: { ...stats, tips: ["feat/a", "feat/b", "feat/c", "feat/d"] }
    });
    expect(markup).toContain("Tips of");
    expect(markup).toContain("feat/a, feat/b +2");
  });

  it("calls only a signature the forge verified verified, and nothing proven", () => {
    // Optional through `requiredKeys`: absent, never `undefined`.
    const forge = fc.constantFrom("github", "gitlab", "gitcafe") as fc.Arbitrary<
      NonNullable<CommitAuthorPerson["forge"]>
    >;
    const person: fc.Arbitrary<CommitAuthorPerson | undefined> = fc.option(
      fc.record(
        {
          state: fc.constantFrom("linked", "none", "pending", "unsupported") as fc.Arbitrary<
            CommitAuthorPerson["state"]
          >,
          identity: fc.constant({ login: "wcastellanos" }),
          signatureVerified: fc.constant(true as const),
          forge
        },
        { requiredKeys: ["state"] }
      ),
      { nil: undefined }
    );
    fc.assert(
      fc.property(person, (subject) => {
        const status = personStatus(subject);
        const verified = subject?.state === "linked" && subject.signatureVerified === true;
        // The oracle: the line claims proof or a verification exactly when
        // the forge verified a signature its author made — never for a match.
        expect(/\bproven\b|\bproof\b|verified by/i.test(status.text)).toBe(verified);
        expect(status.tone === "verified").toBe(verified);
      })
    );
  });

  it("says a verified signature plainly, in green", () => {
    const markup = card({ ...LINKED, signatureVerified: true });
    expect(markup).toContain("Signed commit verified by GitHub");
    expect(markup).toContain("person-card__status is-verified");
    expect(personStatus({ state: "linked", identity: { login: "x" }, forge: "gitlab" }).text)
      .toBe("Matched to this GitLab account, not verified");
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
