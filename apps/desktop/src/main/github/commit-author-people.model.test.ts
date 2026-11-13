import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { GitHubCommitAuthorIdentityLookup } from "@pwrgit/shared";
import type { ForgeRepo } from "../forge/types";
import {
  CommitAuthorPeopleStore,
  PEOPLE_MAX_COMMITS_PER_AUTHOR,
  PEOPLE_REQUESTS_PER_TICK,
  PEOPLE_SETTLE_MS,
  PEOPLE_TICK_SPACING_MS
} from "./commit-author-people";

/**
 * The store's request budget on a forge that batches (GitHub: 50 commits per
 * GraphQL request), against a model of the identity cache.
 *
 * Rules (review finding 2 on #594, and the schedule's own promises):
 * - every visible author's interest commits — all of them, not only the
 *   newest — get an exact answer, so a signature on any can be seen;
 * - one tick never spends more than `PEOPLE_REQUESTS_PER_TICK` requests;
 * - a request carries at least ⌊50/3⌋ authors unless fewer are due, so the
 *   whole graph costs ⌈authors/16⌉ requests and ⌈authors/64⌉ ticks;
 * - an author whose email already maps to an account, but none of whose
 *   commits were checked, is still visited: the account row says whose email
 *   it is, not who signed.
 *
 * The pre-fix store asked one commit per author per visit, four authors per
 * tick, and left an author the account row answered alone for six hours.
 */
const BATCH = 50;
const GITHUB: ForgeRepo = { kind: "github", host: "github.com", path: "octo-org/example" };
const FRESH = { cacheState: "fresh", refreshState: "idle", refreshedAt: 1 } as const;

type Author = { name: string; email: string; commitHashes: string[]; linked: boolean };

const authors = fc.integer({ min: 1, max: 90 }).chain((count) =>
  fc.tuple(
    fc.array(fc.integer({ min: 1, max: PEOPLE_MAX_COMMITS_PER_AUTHOR }), {
      minLength: count,
      maxLength: count
    }),
    fc.array(fc.boolean(), { minLength: count, maxLength: count }),
    fc.array(fc.boolean(), { minLength: count, maxLength: count })
  ).map(([commitCounts, linked, knownAccount]) =>
    commitCounts.map((commits, index): Author & { knownAccount: boolean } => ({
      name: `Author ${index}`,
      email: `author-${index}@example.test`,
      commitHashes: Array.from({ length: commits }, (_, commit) =>
        (index * 8 + commit + 1).toString(16).padStart(40, "0")
      ),
      linked: linked[index] === true,
      knownAccount: linked[index] === true && knownAccount[index] === true
    }))
  )
);

describe("CommitAuthorPeopleStore on a batching forge (model)", () => {
  it("checks every interest commit of every author within the request budget", async () => {
    await fc.assert(
      fc.asyncProperty(authors, async (roster) => {
        let now = 1_000_000;
        const byEmail = new Map(roster.map((author) => [author.email.toLowerCase(), author]));
        /** The identity cache: commits with an exact answer, and email→account rows. */
        const exact = new Set<string>();
        const accounts = new Set(
          roster.filter((author) => author.knownAccount).map((author) => author.email)
        );
        let requestsThisTick = 0;
        let requests = 0;

        const answer = (commitHash: string, email: string): GitHubCommitAuthorIdentityLookup => {
          const author = byEmail.get(email.toLowerCase())!;
          if (exact.has(commitHash)) {
            return author.linked ? { ...FRESH, identity: { login: author.name } } : FRESH;
          }
          if (accounts.has(author.email)) {
            return { ...FRESH, identity: { login: author.name }, signatureUnchecked: true };
          }
          return { cacheState: "miss", refreshState: "idle" };
        };
        const ask = (commitHash: string, email: string): GitHubCommitAuthorIdentityLookup => {
          exact.add(commitHash);
          const author = byEmail.get(email.toLowerCase())!;
          if (author.linked) accounts.add(author.email);
          return answer(commitHash, email);
        };

        const store = new CommitAuthorPeopleStore({
          identities: {
            request: (input) => {
              if (input.cacheOnly !== true) {
                requests += 1;
                requestsThisTick += 1;
                const lookup = ask(input.commitHash, input.authorEmail);
                return { lookup, completion: Promise.resolve(lookup) };
              }
              const lookup = answer(input.commitHash, input.authorEmail);
              return { lookup, completion: Promise.resolve(lookup) };
            },
            requestMany: async ({ commits }) => {
              // The service chunks at the transport's limit, so this is the
              // most it can send for what the store handed it.
              const sent = Math.ceil(commits.length / BATCH);
              requests += sent;
              requestsThisTick += sent;
              return commits.map((commit) => ask(commit.commitHash, commit.authorEmail));
            },
            commitsPerRequest: () => BATCH,
            worktreeForge: async () => GITHUB
          },
          publish: () => {},
          now: () => now,
          setTimer: (() => ({ unref() {} })) as unknown as typeof globalThis.setTimeout,
          clearTimer: (() => {}) as unknown as typeof globalThis.clearTimeout
        });

        await store.replace("window:1", "wt-1", roster);
        now += PEOPLE_SETTLE_MS;
        const ticks = Math.ceil(roster.length / (PEOPLE_REQUESTS_PER_TICK * Math.floor(BATCH / 3)));
        for (let tick = 0; tick < ticks; tick += 1) {
          requestsThisTick = 0;
          await store.tick();
          expect(requestsThisTick).toBeLessThanOrEqual(PEOPLE_REQUESTS_PER_TICK);
          now += PEOPLE_TICK_SPACING_MS;
        }

        const unchecked = roster.flatMap((author) =>
          author.commitHashes.filter((hash) => !exact.has(hash))
        );
        expect(unchecked).toEqual([]);
        expect(requests).toBeLessThanOrEqual(Math.ceil(roster.length / Math.floor(BATCH / 3)));
        store.stop();
      }),
      { numRuns: 80 }
    );
  });
});
