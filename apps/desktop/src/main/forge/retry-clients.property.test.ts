import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The retry policy and the batch rule, through the two REAL clients.
 *
 * `retry.property.test.ts` holds `forgeRetryDelayMs` to its promises. That is
 * not enough on its own: each client reads status and headers off its own
 * error type (Octokit hangs a record off `error.response`; `fetch` gives
 * GitLab a `Headers`), and #225's bug lived exactly there — `Headers.get`
 * answers null, and `Number(null)` is 0. So this file drives
 * `fetchPrsForRepo` and `fetchMrsForBranches` with the same generated
 * responses and compares what each one waited and how each one ended.
 *
 * It also holds #230's rule on both: a batch that fails keeps the batches
 * before it, never asks for the ones after it, and only a failed first batch
 * throws.
 *
 * Only the transports are stubbed — Octokit's client and global `fetch` — plus
 * `delay`, which records the wait instead of sleeping. No network.
 */

const { client, waits } = vi.hoisted(() => ({
  client: vi.fn(),
  waits: [] as number[]
}));

vi.mock("@octokit/graphql", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octokit/graphql")>();
  return { ...actual, graphql: { defaults: () => client } };
});

vi.mock("../util/timing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/timing")>();
  return {
    ...actual,
    delay: async (ms: number) => {
      waits.push(ms);
    }
  };
});

import { fetchPrsForRepo } from "../github/pr-client";
import { fetchMrsForBranches } from "./gitlab/mr-client";
import type { ForgeRepo } from "./types";

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const GITHUB_REPO = { host: "github.com" };
const GITLAB_REPO: ForgeRepo = { kind: "gitlab", host: "gitlab.com", path: "g/sub/app" };
/** Both clients walk branches 50 to a request (`BATCH`, `BRANCH_BATCH`). */
const CHUNK = 50;

type Failure = {
  /** Undefined is a request that never got an answer. */
  status: number | undefined;
  retryAfter?: string;
  remaining?: string;
  reset?: string;
};
type Step = { ok: true } | ({ ok: false } & Failure);

const valueArb = (relative: fc.Arbitrary<string>) =>
  fc.option(
    fc.oneof(fc.constantFrom("", " ", "0", "abc", "1.5", "0.001"), relative),
    { nil: undefined }
  );

/** Any failure but a 403: GitHub reads a spent 403 as a rate limit and GitLab
 *  does not, on purpose (`RATE_LIMIT_DIALECT`). That asymmetry is its own
 *  property below. */
const failureArb: fc.Arbitrary<Failure> = fc
  .record({
    status: fc.oneof(
      fc.constant(undefined),
      fc.constantFrom(400, 401, 404, 422, 429, 429, 500, 502, 503),
      fc.integer({ min: 400, max: 599 }).filter((s) => s !== 403)
    ),
    retryAfter: valueArb(fc.integer({ min: 1, max: 90 }).map(String)),
    remaining: valueArb(fc.nat({ max: 3 }).map(String)),
    reset: valueArb(fc.integer({ min: -60, max: 120 }).map((d) => String(NOW_S + d)))
  })
  .map((raw) => {
    const failure: Failure = { status: raw.status };
    if (raw.retryAfter !== undefined) failure.retryAfter = raw.retryAfter;
    if (raw.remaining !== undefined) failure.remaining = raw.remaining;
    if (raw.reset !== undefined) failure.reset = raw.reset;
    return failure;
  });

const stepsArb: fc.Arbitrary<Step[]> = fc.array(
  fc.oneof(
    { weight: 4, arbitrary: failureArb.map((f): Step => ({ ok: false, ...f })) },
    { weight: 1, arbitrary: fc.constant<Step>({ ok: true }) }
  ),
  { minLength: 1, maxLength: 7 }
);

function headerBag(failure: Failure, remaining: string, reset: string): Record<string, string> {
  const bag: Record<string, string> = {};
  if (failure.retryAfter !== undefined) bag["retry-after"] = failure.retryAfter;
  if (failure.remaining !== undefined) bag[remaining] = failure.remaining;
  if (failure.reset !== undefined) bag[reset] = failure.reset;
  return bag;
}

/** What `@octokit/request` rejects with: headers hang off `response`. */
function githubRejection(failure: Failure): unknown {
  if (failure.status === undefined) return new Error("socket hang up");
  const headers = headerBag(failure, "x-ratelimit-remaining", "x-ratelimit-reset");
  return Object.assign(new Error(`HTTP ${failure.status}`), {
    status: failure.status,
    response: { status: failure.status, headers, data: null }
  });
}

function githubPage(branches: string[]): unknown {
  return {
    repository: Object.fromEntries(
      branches.map((_, i) => [`a${i}`, { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }])
    )
  };
}

function gitlabResponse(failure: Failure | null): Response {
  const status = failure?.status ?? 200;
  return {
    ok: failure === null,
    status,
    headers: new Headers(
      failure === null ? {} : headerBag(failure, "ratelimit-remaining", "ratelimit-reset")
    ),
    json: async () => ({
      data: { project: { mergeRequests: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } } } }
    })
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  client.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  waits.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Run = { waits: number[]; requests: number; outcome: "answered" | "threw" };

async function settle(work: Promise<unknown>): Promise<"answered" | "threw"> {
  try {
    await work;
    return "answered";
  } catch {
    return "threw";
  }
}

/** One branch, the responses in order, then answers forever. */
async function runGithub(steps: Step[]): Promise<Run> {
  waits.length = 0;
  client.mockReset();
  let call = 0;
  client.mockImplementation(async () => {
    const step = steps[call++];
    if (step === undefined || step.ok) return githubPage(["feat"]);
    throw githubRejection(step);
  });
  const outcome = await settle(fetchPrsForRepo("t", GITHUB_REPO, "o", "r", ["feat"]));
  return { waits: [...waits], requests: call, outcome };
}

async function runGitlab(steps: Step[]): Promise<Run> {
  waits.length = 0;
  fetchMock.mockReset();
  let call = 0;
  fetchMock.mockImplementation(async () => {
    const step = steps[call++];
    if (step === undefined || step.ok) return gitlabResponse(null);
    if (step.status === undefined) throw new TypeError("fetch failed");
    return gitlabResponse(step);
  });
  const outcome = await settle(fetchMrsForBranches("t", GITLAB_REPO, ["feat"]));
  return { waits: [...waits], requests: call, outcome };
}

describe("both clients back off the same way", () => {
  it("for any sequence of responses", async () => {
    await fc.assert(
      fc.asyncProperty(stepsArb, async (steps) => {
        const github = await runGithub(steps);
        const gitlab = await runGitlab(steps);
        expect(gitlab).toEqual(github);
        for (const wait of github.waits) {
          expect(wait).toBeGreaterThanOrEqual(1000);
          expect(wait).toBeLessThanOrEqual(60_000);
        }
      })
    );
  });

  it("parts only on a 403: GitHub waits out a spent window, GitLab does not", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 59 }), async (inSeconds) => {
        const spent: Step = {
          ok: false,
          status: 403,
          remaining: "0",
          reset: String(NOW_S + inSeconds)
        };
        const github = await runGithub([spent]);
        const gitlab = await runGitlab([spent]);
        expect(github.waits).toEqual([Math.max(inSeconds * 1000, 1000)]);
        expect(github.outcome).toBe("answered");
        expect(gitlab).toEqual({ waits: [], requests: 1, outcome: "threw" });
      })
    );
  });

  it("backs a header-less 429 off from one second on both (#225)", async () => {
    const bare: Step = { ok: false, status: 429 };
    expect((await runGitlab([bare, bare])).waits).toEqual([1000, 2000]);
    expect((await runGithub([bare, bare])).waits).toEqual([1000, 2000]);
  });
});

/**
 * #230: "A batch that fails keeps the batches before it" (`chunked.ts`).
 * Branch `bN` is in chunk `floor(N / 50)`; the stubs fail every request for
 * one chunk and answer the rest.
 */
describe("a failed batch keeps the batches that resolved", () => {
  const caseArb = fc
    .integer({ min: 1, max: 4 * CHUNK })
    .chain((count) =>
      fc.record({
        count: fc.constant(count),
        failing: fc.integer({ min: 0, max: Math.ceil(count / CHUNK) }),
        status: fc.constantFrom(404, 422, 500, 429)
      })
    );

  const chunkOf = (branch: string) => Math.floor(Number(branch.slice(1)) / CHUNK);

  function expectKept(
    result: Map<string, unknown> | "threw",
    branches: string[],
    failing: number,
    asked: Set<number>
  ): void {
    const chunks = Math.ceil(branches.length / CHUNK);
    if (failing === 0) {
      expect(result).toBe("threw");
    } else {
      expect(result).not.toBe("threw");
      const kept = [...(result as Map<string, unknown>).keys()].sort();
      const want = branches.filter((b) => chunkOf(b) < failing).sort();
      expect(kept).toEqual(want);
    }
    // The walk stops at the failure: no later chunk is ever asked.
    for (const chunk of asked) expect(chunk).toBeLessThanOrEqual(Math.min(failing, chunks - 1));
  }

  it("on GitHub", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async ({ count, failing, status }) => {
        const branches = Array.from({ length: count }, (_, i) => `b${i}`);
        const asked = new Set<number>();
        client.mockReset();
        client.mockImplementation(async (_query: string, variables: Record<string, string>) => {
          const chunk = branches.filter((b) => Object.values(variables).includes(b));
          const index = chunkOf(chunk[0]!);
          asked.add(index);
          if (index === failing) throw githubRejection({ status });
          return githubPage(chunk);
        });
        let result: Map<string, unknown> | "threw";
        try {
          result = await fetchPrsForRepo("t", GITHUB_REPO, "o", "r", branches);
        } catch {
          result = "threw";
        }
        expectKept(result, branches, failing, asked);
      })
    );
  });

  it("on GitLab", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async ({ count, failing, status }) => {
        const branches = Array.from({ length: count }, (_, i) => `b${i}`);
        const asked = new Set<number>();
        fetchMock.mockReset();
        fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as { variables: { branches: string[] } };
          const index = chunkOf(body.variables.branches[0]!);
          asked.add(index);
          return gitlabResponse(index === failing ? { status } : null);
        });
        let result: Map<string, unknown> | "threw";
        try {
          result = await fetchMrsForBranches("t", GITLAB_REPO, branches);
        } catch {
          result = "threw";
        }
        expectKept(result, branches, failing, asked);
      })
    );
  });
});
