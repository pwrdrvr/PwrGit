import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  signedByAuthor,
  type CommitAuthorRemoteCommit,
  type CommitSignatureVerdict
} from "./commit-author";

/**
 * The rule the person card's "verified" rests on: a signature speaks for the
 * author only when it is valid, the forge did not make it itself, and its key
 * belongs to the very account the commit is linked to. Everything else — no
 * signature, a bad one, GitHub signing a squash merge as `web-flow`, a
 * reviewer's signed cherry-pick, a signature with no named signer — is a
 * match at best, never verified.
 */
const login = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/);
/** Spellings a forge may hand back for the same login. */
const respell = (value: string): fc.Arbitrary<string> =>
  fc.constantFrom(value, value.toUpperCase(), ` ${value}`, `${value}\t`);

const signature: fc.Arbitrary<CommitSignatureVerdict | undefined> = fc.option(
  fc.record(
    {
      valid: fc.boolean(),
      signedByForge: fc.boolean(),
      signerLogin: login
    },
    { requiredKeys: ["valid", "signedByForge"] }
  ),
  { nil: undefined }
);
const account: fc.Arbitrary<CommitAuthorRemoteCommit["account"]> = fc.option(
  login.map((value) => ({ login: value })),
  { nil: undefined }
);

describe("signedByAuthor", () => {
  it("is verified only for a valid signature the linked account made, not the forge", () => {
    fc.assert(
      fc.property(account, signature, (linked, verdict) => {
        const response = {
          ...(linked === undefined ? {} : { account: linked }),
          ...(verdict === undefined ? {} : { signature: verdict })
        };
        expect(signedByAuthor(response)).toBe(
          verdict?.valid === true &&
            !verdict.signedByForge &&
            linked != null &&
            verdict.signerLogin === linked.login
        );
      })
    );
  });

  it("ignores case and surrounding whitespace in the two logins", () => {
    fc.assert(
      fc.property(
        login.chain((value) => fc.tuple(respell(value), respell(value))),
        ([accountLogin, signerLogin]) => {
          expect(signedByAuthor({
            account: { login: accountLogin },
            signature: { valid: true, signedByForge: false, signerLogin }
          })).toBe(true);
        }
      )
    );
  });

  it("never verifies a commit the forge signed, even when it names the author", () => {
    fc.assert(
      fc.property(login, (value) => {
        expect(signedByAuthor({
          account: { login: value },
          signature: { valid: true, signedByForge: true, signerLogin: value }
        })).toBe(false);
      })
    );
  });
});
