// @vitest-environment jsdom

/**
 * A model test for the debounced, paged search hooks (`useTagSearch`,
 * `useRemoteBranchSearch`). Each stamps its fetches with a generation so that
 * only the newest may write state: "slow responses WILL land out of order".
 * Random sequences of typing, debounce time passing, Load more and responses
 * arriving (in an order fc.scheduler picks) run against the real hooks.
 *
 * Rule: once a search says it is done (not loading, no error), what it shows
 * is the server's answer for the query on screen now — a prefix of the
 * matching rows, with the matching total. Callers read `!loading` as "these
 * are the results".
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("./pwrgit", () => ({ dispatch: mocks.dispatch }));

import { useRemoteBranchSearch } from "./useRemoteBranchSearch";
import { useTagSearch } from "./useTagSearch";

const NAMES = ["alpha", "apple", "banana", "cab", "abba", "bob", "zed"];
const QUERIES = ["", "a", "ab", "b"];
const PAGE = 2;
const matching = (query: string): string[] => NAMES.filter((name) => name.includes(query));

type View = { rows: { name: string }[]; total: number; loading: boolean; error: string | null; loadMore: () => void };
type Hook = (args: { repoId: string; query: string; pageSize: number }) => View;

const HOOKS: [string, string, Hook][] = [
  ["useTagSearch", "repo:tags", (args) => useTagSearch(args) as unknown as View],
  ["useRemoteBranchSearch", "repo:remoteBranches", (args) => useRemoteBranchSearch(args) as unknown as View]
];

type World = {
  s: fc.Scheduler;
  root: Root;
  container: HTMLDivElement;
  query: string;
  view: View | null;
};
type Model = Record<string, never>;

let world: World | null = null;

function Harness({ hook, query, w }: { hook: Hook; query: string; w: World }) {
  w.view = hook({ repoId: "repo-1", query, pageSize: PAGE });
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(async () => undefined);
}

function assertShowsCurrentQuery(w: World): void {
  const view = w.view;
  if (view === null || view.loading || view.error !== null) return;
  const expected = matching(w.query);
  const names = view.rows.map((row) => row.name);
  const prefix = expected.slice(0, names.length);
  if (view.total !== expected.length || names.join(",") !== prefix.join(",")) {
    throw new Error(
      `done loading for "${w.query}" but shows [${names.join(", ")}] of ${view.total}; ` +
        `expected a prefix of [${expected.join(", ")}] of ${expected.length}`
    );
  }
}

type Command = fc.AsyncCommand<Model, World>;

class Type implements Command {
  constructor(readonly hook: Hook, readonly query: string) {}
  check = () => true;
  async run(_m: Model, w: World): Promise<void> {
    w.query = this.query;
    await act(async () => w.root.render(<Harness hook={this.hook} query={this.query} w={w} />));
    await settle();
    assertShowsCurrentQuery(w);
  }
  toString = () => `type "${this.query}"`;
}

class Advance implements Command {
  constructor(readonly ms: number) {}
  check = () => true;
  async run(_m: Model, w: World): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(this.ms);
    });
    await settle();
    assertShowsCurrentQuery(w);
  }
  toString = () => `advance ${this.ms}ms`;
}

class LoadMore implements Command {
  check = () => true;
  async run(_m: Model, w: World): Promise<void> {
    await act(async () => w.view?.loadMore());
    await settle();
    assertShowsCurrentQuery(w);
  }
  toString = () => "load more";
}

class Deliver implements Command {
  check = () => true;
  async run(_m: Model, w: World): Promise<void> {
    if (w.s.count() === 0) return;
    await act(async () => {
      await w.s.waitOne();
    });
    await settle();
    assertShowsCurrentQuery(w);
  }
  toString = () => "deliver";
}

async function runScenario(hook: Hook, command: string, s: fc.Scheduler, cmds: Iterable<Command>): Promise<void> {
  mocks.dispatch.mockReset();
  mocks.dispatch.mockImplementation((name: string, req: { query: string; offset: number; limit: number }) => {
    if (name !== command) return Promise.resolve(ok(null));
    const all = matching(req.query);
    const value = { rows: all.slice(req.offset, req.offset + req.limit).map((n) => ({ name: n })), total: all.length };
    return s.schedule(Promise.resolve(ok(value)), `"${req.query}" @${req.offset}`);
  });
  const container = document.createElement("div");
  document.body.append(container);
  const w: World = { s, root: createRoot(container), container, query: "", view: null };
  world = w;
  await act(async () => w.root.render(<Harness hook={hook} query="" w={w} />));
  await fc.asyncModelRun(() => ({ model: {}, real: w }), cmds);
  // Let every debounce fire and every response land; it must end right.
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    while (s.count() > 0) {
      await act(async () => {
        await s.waitOne();
      });
      await settle();
      assertShowsCurrentQuery(w);
    }
  }
}

async function cleanup(): Promise<void> {
  const w = world;
  world = null;
  if (w === null) return;
  await act(async () => w.root.unmount());
  w.container.remove();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
});

describe.each(HOOKS)("%s (model)", (_name, command, hook) => {
  const commands = [
    fc.constantFrom(...QUERIES).map((q) => new Type(hook, q)),
    fc.constantFrom(100, 200).map((ms) => new Advance(ms)),
    fc.constant(new LoadMore()),
    fc.constant(new Deliver()),
    fc.constant(new Deliver())
  ];

  it("shows only the current query's results once it stops loading", async () => {
    await fc.assert(
      fc
        .asyncProperty(fc.scheduler(), fc.commands(commands, { size: "+1", maxCommands: 20 }), (s, cmds) =>
          runScenario(hook, command, s, cmds)
        )
        .afterEach(cleanup),
      { numRuns: 50 }
    );
  });

  // What the model shrank to (run 1–2) before a new query retired the fetch
  // in flight: the empty query's answer landed during "b"'s debounce and was
  // shown, as done, for "b".
  it('the empty query\'s fetch starts, type "b", it answers: not shown for "b"', async () => {
    try {
      await runScenario(hook, command, fc.sample(fc.scheduler(), { numRuns: 1 })[0] as fc.Scheduler, [
        new Advance(200),
        new Type(hook, "b"),
        new Deliver()
      ]);
    } finally {
      await cleanup();
    }
  });
});
