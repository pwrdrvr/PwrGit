import fc from "fast-check";
import { err, ok, type Result, type TagSourceState } from "@pwrgit/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import type { GitExec, GitOutput } from "./dugite";
import { TAG_CHECK_CONCURRENCY, TagAutoChecks, type TagAutoCheckOptions } from "./tag-auto-check";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

/**
 * The automatic tag checks as a model: any interleaving of syncs finishing,
 * the switch flipping, user operations yielding and listings answering.
 * The rules: never more than TAG_CHECK_CONCURRENCY listings at once from
 * syncs, nothing at all while the switch is off, never a `--no-tags` remote,
 * and a remote that failed (not one that yielded) is not listed again
 * within the back-off.
 */

const REPOS = ["r0", "r1", "r2", "r3", "r4"] as const;
const NO_TAGS = new Set(["r4"]);
const dbs: DB[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function database(): DB {
  const db = openDatabase(":memory:");
  dbs.push(db);
  db.prepare("INSERT INTO profiles (id, name, email) VALUES ('p1', 'P', 'p@example.com')").run();
  for (const id of REPOS) db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, 'p1', ?, ?)").run(id, id, `/repos/${id}`);
  return db;
}

/** `started` and `ended` count events in one sequence, so "after" means after. */
type Listing = { repo: string; outcome: "ok" | "fail" | "aborted"; started: number; ended: number };

/** A fake world: `ls-remote` answers only when the scheduler says so. */
function world(s: fc.Scheduler, outcomes: ("ok" | "fail")[]) {
  let enabled = true;
  let inFlight = 0;
  let maxInFlight = 0;
  let clock = 0;
  const sourceCalls: { repo: string; enabled: boolean }[] = [];
  const listings: Listing[] = [];
  const recounts: string[] = [];
  const git: GitExec = (args, _cwd, options) =>
    new Promise<Result<GitOutput>>((resolve) => {
      const signal = options?.signal;
      const aborted = () => resolve(err({ kind: "git", code: "aborted", message: "stopped" }));
      if (signal?.aborted === true) return aborted();
      signal?.addEventListener("abort", aborted, { once: true });
      const outcome = outcomes.length === 0 ? "ok" : outcomes.shift()!;
      void s.schedule(Promise.resolve(outcome), `${args[0]} ${outcome}`).then(() =>
        resolve(
          outcome === "ok"
            ? ok({ stdout: "", stderr: "", exitCode: 0 })
            : err({ kind: "remote", code: "fetch_failed", message: "unreachable" })
        )
      );
    });
  const state = (repo: string): TagSourceState => ({
    remotes: ["origin"],
    primary: "origin",
    chosen: false,
    tagOpt: NO_TAGS.has(repo) ? "no-tags" : null,
    checkedAt: null,
    publishedCount: 0,
    error: null,
    stale: true
  });
  const sources = {
    source: async (_git: GitExec, repo: string) => {
      sourceCalls.push({ repo, enabled });
      return ok({ state: state(repo), remote: { name: "origin", url: "/o.git", tagOpt: null } });
    },
    refresh: async (exec: GitExec, repo: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const listing: Listing = { repo, outcome: "ok", started: ++clock, ended: 0 };
      listings.push(listing);
      const answer = await exec(["ls-remote", "--tags", "origin"], `/repos/${repo}`);
      inFlight -= 1;
      listing.ended = ++clock;
      if (answer.ok) return ok(undefined);
      listing.outcome = answer.error.code === "aborted" ? "aborted" : "fail";
      return err(answer.error);
    },
    recountPublisher: async (_git: GitExec, repo: string) => {
      recounts.push(repo);
      return ok(false);
    },
    store: { recordFailure: () => undefined }
  } as unknown as NonNullable<TagAutoCheckOptions["sources"]>;
  return {
    sources,
    git,
    setEnabled: (next: boolean) => {
      enabled = next;
    },
    enabled: () => enabled,
    sourceCalls,
    listings,
    recounts,
    maxInFlight: () => maxInFlight
  };
}

async function settle(s: fc.Scheduler): Promise<void> {
  for (let round = 0; round < 200; round += 1) {
    if (s.count() > 0) await s.waitAll();
    await new Promise((resolve) => setImmediate(resolve));
    if (s.count() === 0 && round > 5) {
      await new Promise((resolve) => setImmediate(resolve));
      if (s.count() === 0) return;
    }
  }
}

const command = fc.oneof(
  fc.record({ kind: fc.constant("sync" as const), repo: fc.constantFrom(...REPOS) }),
  fc.record({ kind: fc.constant("toggle" as const), on: fc.boolean() }),
  fc.record({ kind: fc.constant("yield" as const), repo: fc.constantFrom(...REPOS) })
);

describe("automatic tag checks (model)", () => {
  it("hold the ceiling, the switch, --no-tags and the failure back-off under any interleaving", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(command, { minLength: 1, maxLength: 24 }),
        fc.array(fc.constantFrom("ok" as const, "fail" as const), { maxLength: 24 }),
        async (s, commands, outcomes) => {
          const w = world(s, [...outcomes]);
          const checks = new TagAutoChecks(database(), {
            sources: w.sources,
            git: w.git,
            enabledAfterSync: w.enabled,
            now: () => 1_000_000
          });
          for (const [index, next] of commands.entries()) {
            void s.schedule(Promise.resolve(index), `command ${index}`).then(() => {
              if (next.kind === "sync") checks.afterSync(next.repo);
              else if (next.kind === "toggle") w.setEnabled(next.on);
              else checks.yield(next.repo);
            });
          }
          await settle(s);

          expect(w.maxInFlight()).toBeLessThanOrEqual(TAG_CHECK_CONCURRENCY);
          // A switched-off sync starts nothing, even one that queued while on.
          // A check that had already started may finish its listing.
          expect(w.sourceCalls.filter((call) => !call.enabled)).toEqual([]);
          expect(w.listings.filter((listing) => NO_TAGS.has(listing.repo))).toEqual([]);
          // The clock is frozen, so a remote whose last answer was a failure
          // is not listed again; a success (also a concurrent one) clears it.
          for (const repo of REPOS) {
            const ofRepo = w.listings.filter((listing) => listing.repo === repo);
            for (const listing of ofRepo) {
              const answered = ofRepo
                .filter((other) => other.outcome !== "aborted" && other.ended > 0 && other.ended < listing.started)
                .sort((x, y) => y.ended - x.ended);
              expect(answered[0]?.outcome, `${repo} listed after a failure: ${JSON.stringify(ofRepo)}`).not.toBe("fail");
            }
          }
        }
      ),
      { numRuns: process.platform === "win32" ? 40 : 200 }
    );
  });
});

describe("automatic tag checks", () => {
  it("the Tags tab's check does not queue behind a bulk sync's", async () => {
    const blocked: (() => void)[] = [];
    const db = database();
    let listings = 0;
    const checks = new TagAutoChecks(db, {
      sources: {
        source: async () =>
          ok({
            state: { remotes: ["origin"], primary: "origin", chosen: false, tagOpt: null, checkedAt: null, publishedCount: 0, error: null, stale: true },
            remote: null
          }),
        refresh: async () => {
          listings += 1;
          await new Promise<void>((resolve) => blocked.push(resolve));
          return ok(undefined);
        },
        recountPublisher: async () => ok(false),
        store: { recordFailure: () => undefined }
      } as unknown as NonNullable<TagAutoCheckOptions["sources"]>
    });
    for (const repo of ["r0", "r1", "r2", "r3"]) checks.afterSync(repo);
    await vi.waitFor(() => expect(listings).toBe(TAG_CHECK_CONCURRENCY));
    const view = checks.view("r4");
    await vi.waitFor(() => expect(listings).toBe(TAG_CHECK_CONCURRENCY + 1));
    blocked.splice(0).forEach((release) => release());
    expect(await view).toBe(true);
    await vi.waitFor(() => expect(listings).toBe(5));
    blocked.splice(0).forEach((release) => release());
  });

  it("a listing stopped by the user's own operation does not start the back-off", async () => {
    const db = database();
    let started = 0;
    const checks = new TagAutoChecks(db, {
      sources: {
        source: async () =>
          ok({
            state: { remotes: ["origin"], primary: "origin", chosen: false, tagOpt: null, checkedAt: null, publishedCount: 0, error: null, stale: true },
            remote: null
          }),
        refresh: async (git: GitExec) => {
          started += 1;
          const answer = await git(["ls-remote"], "/repos/r0");
          return answer.ok ? ok(undefined) : err(answer.error);
        },
        recountPublisher: async () => ok(false),
        store: { recordFailure: () => undefined }
      } as unknown as NonNullable<TagAutoCheckOptions["sources"]>,
      git: (_args, _cwd, options) =>
        new Promise((resolve) =>
          options?.signal?.addEventListener("abort", () =>
            resolve(err({ kind: "git", code: "aborted", message: "stopped" }))
          )
        )
    });
    const first = checks.view("r0");
    await vi.waitFor(() => expect(started).toBe(1));
    checks.yield("r0");
    expect(await first).toBe(false);
    const second = checks.view("r0");
    await vi.waitFor(() => expect(started).toBe(2));
    checks.yield("r0");
    expect(await second).toBe(false);
  });
});
