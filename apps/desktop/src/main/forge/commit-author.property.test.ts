import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { signedByAuthor, type CommitAuthorRemoteCommit } from "./commit-author";

/**
 * The rule the person card's "verified" rests on: a forge verifies a
 * signature against the *committer*, so it speaks for the author only when
 * the committer is the author. Everything else — no verdict, a false
 * verdict, GitHub committing a squash merge, a reviewer's cherry-pick — is a
 * match at best, never verified.
 */
const local = fc.stringMatching(/^[a-z][a-z0-9.]{0,8}$/);
const domain = fc.constantFrom("example.test", "users.noreply.github.com", "github.com");
const email = fc.tuple(local, domain).map(([l, d]) => `${l}@${d}`);
/** Spellings a forge or Git config may hand back for the same address. */
const respell = (value: string): fc.Arbitrary<string> =>
  fc.constantFrom(value, value.toUpperCase(), ` ${value}`, `${value}\t`);

const verdict = fc.constantFrom<CommitAuthorRemoteCommit["signatureVerified"]>(
  true,
  false,
  undefined
);

describe("signedByAuthor", () => {
  it("is verified only with the forge's true verdict on a commit its author committed", () => {
    fc.assert(
      fc.property(email, email, verdict, (authorEmail, committerEmail, signatureVerified) => {
        const response = {
          author: { name: "Someone", email: authorEmail },
          committer: { email: committerEmail },
          ...(signatureVerified === undefined ? {} : { signatureVerified })
        };
        expect(signedByAuthor(response)).toBe(
          signatureVerified === true && authorEmail === committerEmail
        );
      })
    );
  });

  it("ignores case and surrounding whitespace in the two emails", () => {
    fc.assert(
      fc.property(
        email.chain((value) => fc.tuple(respell(value), respell(value))),
        ([authorEmail, committerEmail]) => {
          expect(signedByAuthor({
            author: { email: authorEmail },
            committer: { email: committerEmail },
            signatureVerified: true
          })).toBe(true);
        }
      )
    );
  });

  it("is never verified without both emails", () => {
    fc.assert(
      fc.property(fc.option(email, { nil: null }), (only) => {
        expect(signedByAuthor({ author: { email: only }, signatureVerified: true })).toBe(false);
        expect(signedByAuthor({ committer: { email: only }, signatureVerified: true })).toBe(false);
        expect(signedByAuthor({ author: null, committer: null, signatureVerified: true }))
          .toBe(false);
      })
    );
  });
});
