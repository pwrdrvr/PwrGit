// @vitest-environment jsdom

/**
 * A model test for RebaseTab's async lifecycle (#541). Random sequences of
 * what an operator does — pick a selection, Check, Apply, the
 * branch moving under them, closing the tab — run against the real
 * component, while fc.scheduler decides when each Check and Apply
 * response arrives. Rules, from the component's own promises:
 *
 * - "Applied locally" shows only for the selection whose Apply resolved.
 *   A late success must not land on a newer selection (or HEAD, or worktree).
 * - Clear (the 900 ms dismiss after Apply) fires only for that selection.
 * - Once unmounted, nothing asks main for anything and nothing calls Clear.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { err, ok } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  clear: vi.fn()
}));
vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: () => () => undefined,
  windowProfileId: () => "work"
}));

import { RebaseTab } from "./RebaseTab";

const h = (id: string): string => id.repeat(40);
// Newest first, as graph:log lists them.
const log = [
  { hash: h("c"), subject: "fix lint" },
  { hash: h("b"), subject: "wip" },
  { hash: h("a"), subject: "add CSV exporter" }
];
const SELECTIONS = [
  log.map((c) => c.hash),
  [h("c"), h("b")],
  [h("b"), h("a")]
];
const proof = { commitCount: 3, resultCount: 1, steps: 3, tree: "4c1f9e0".padEnd(40, "0"), durationMs: 600 };

type ApplyOutcome = "ok" | "signing_failed" | "git_failed";
type CheckOutcome = "clean" | "conflict";
type Outcomes = { apply: ApplyOutcome[]; check: CheckOutcome[] };

type Props = { worktreeId: string; sourceHead: string; selection: number; op: "reorder" | "squash" };
const keyOf = (p: Props): string => `${p.worktreeId}|${p.sourceHead}|${p.selection}|${p.op}`;

type World = {
  s: fc.Scheduler;
  root: Root;
  container: HTMLDivElement;
  props: Props;
  /** Bumped whenever what the tab shows changes (selection, HEAD, worktree, op). */
  context: number;
  unmounted: boolean;
  /** Contexts in which an Apply that was issued there resolved ok. */
  appliedIn: Set<number>;
  violations: string[];
  counts: { apply: number; check: number };
};
type Model = { unmounted: boolean };

let world: World | null = null;

function buttonNamed(w: World, name: string): HTMLButtonElement | undefined {
  return [...w.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
}

async function settle(): Promise<void> {
  // Requests the scheduler doesn't hold (graph:log, rebase:draft) resolve in microtasks; let them and their renders land.
  for (let i = 0; i < 4; i++) await act(async () => undefined);
}

async function renderTab(w: World): Promise<void> {
  const { worktreeId, sourceHead, selection, op } = w.props;
  await act(async () => {
    w.root.render(
      <RebaseTab
        worktreeId={worktreeId}
        sourceHead={sourceHead}
        selectedHashes={SELECTIONS[selection] ?? []}
        op={op}
        branch="feat/csv-export"
        onClear={mocks.clear}
      />
    );
  });
  await settle();
}

function assertInvariants(w: World): void {
  if (w.violations.length > 0) throw new Error(w.violations.join("\n"));
  if (w.unmounted) return;
  if (w.container.querySelector(".rebase-applied") !== null && !w.appliedIn.has(w.context)) {
    throw new Error("shows Applied locally for a selection whose Apply never resolved");
  }
}

function route(w: World, outcomes: Outcomes): void {
  const pick = <T,>(list: T[], i: number): T => list[i % list.length] as T;
  mocks.dispatch.mockImplementation((name: string, req: Record<string, unknown>) => {
    if (w.unmounted) w.violations.push(`dispatched ${name} after unmount`);
    switch (name) {
      case "graph:log":
        return Promise.resolve(ok({ commits: log }));
      case "rebase:draft":
        return Promise.resolve(ok({ op: req["op"], valid: true, summary: "→ 1 commit", steps: [] }));
      case "rebase:check": {
        const n = w.counts.check++;
        const outcome = pick(outcomes.check, n);
        const value =
          outcome === "clean"
            ? ok({ status: "clean", approvalToken: `token-${n}`, sourceHead: "head", message: "ok", proof })
            : ok({
                status: "snag",
                code: "conflict",
                message: "Conflict.",
                detail: { kind: "conflict", step: 2, total: 3, hash: h("c"), subject: "fix lint", files: ["a.ts"] }
              });
        return w.s.schedule(Promise.resolve(value), `check ${outcome}`);
      }
      case "rebase:apply": {
        const issuedIn = w.context;
        const outcome = pick(outcomes.apply, w.counts.apply++);
        const value =
          outcome === "ok"
            ? ok({})
            : err({ kind: "git", code: outcome, message: `Apply ${outcome}.` });
        return w.s.schedule(Promise.resolve(value), `apply ${outcome}`).then((v) => {
          if (outcome === "ok") w.appliedIn.add(issuedIn);
          return v;
        });
      }
      default:
        return Promise.resolve(ok(null));
    }
  });
  mocks.clear.mockImplementation(() => {
    if (w.unmounted) w.violations.push("Clear called after unmount");
    else if (!w.appliedIn.has(w.context)) {
      w.violations.push("Clear called on a selection whose Apply never resolved");
    }
  });
}

type Command = fc.AsyncCommand<Model, World>;

class Show implements Command {
  constructor(readonly next: Partial<Props>, readonly label: string) {}
  check = (m: Readonly<Model>) => !m.unmounted;
  async run(_m: Model, w: World): Promise<void> {
    const props = { ...w.props, ...this.next };
    if (keyOf(props) !== keyOf(w.props)) w.context += 1;
    w.props = props;
    await renderTab(w);
    assertInvariants(w);
  }
  toString = () => this.label;
}

class Click implements Command {
  constructor(readonly name: string, readonly find: (w: World) => HTMLButtonElement | undefined) {}
  check = (m: Readonly<Model>) => !m.unmounted;
  async run(_m: Model, w: World): Promise<void> {
    const el = this.find(w);
    if (el === undefined || el.disabled) return;
    await act(async () => el.click());
    await settle();
    assertInvariants(w);
  }
  toString = () => `click ${this.name}`;
}

class Deliver implements Command {
  check = () => true;
  async run(_m: Model, w: World): Promise<void> {
    if (w.s.count() === 0) return;
    await act(async () => {
      await w.s.waitOne();
    });
    await settle();
    assertInvariants(w);
  }
  toString = () => "deliver";
}

class Advance implements Command {
  constructor(readonly ms: number) {}
  check = () => true;
  async run(_m: Model, w: World): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(this.ms);
    });
    await settle();
    assertInvariants(w);
  }
  toString = () => `advance ${this.ms}ms`;
}

class Unmount implements Command {
  check = (m: Readonly<Model>) => !m.unmounted;
  async run(m: Model, w: World): Promise<void> {
    await act(async () => w.root.unmount());
    m.unmounted = true;
    w.unmounted = true;
    assertInvariants(w);
  }
  toString = () => "unmount";
}

let heads = 0;
const commands = [
  fc
    .record({
      selection: fc.integer({ min: 0, max: SELECTIONS.length - 1 }),
      op: fc.constantFrom("reorder" as const, "squash" as const),
      worktreeId: fc.constantFrom("wt-1", "wt-2")
    })
    .map((next) => new Show(next, `select ${next.worktreeId} #${next.selection} ${next.op}`)),
  fc.constant(null).map(() => new Show({ sourceHead: `head-${++heads}` }, "change HEAD")),
  // Check, Apply and Deliver weigh more: reaching Apply takes Check, its
  // answer, then Apply, and a uniform pick rarely strings those together.
  fc.constant(new Click("Check", (w) => w.container.querySelector<HTMLButtonElement>(".rebase-check") ?? undefined)),
  fc.constant(new Click("Check", (w) => w.container.querySelector<HTMLButtonElement>(".rebase-check") ?? undefined)),
  fc.constant(new Click("Apply", (w) => w.container.querySelector<HTMLButtonElement>(".rebase-apply") ?? undefined)),
  fc.constant(new Click("Apply", (w) => w.container.querySelector<HTMLButtonElement>(".rebase-apply") ?? undefined)),
  fc.constant(new Click("Apply unsigned", (w) => buttonNamed(w, "Apply without signing, this once"))),
  fc.constant(new Deliver()),
  fc.constant(new Deliver()),
  fc.constant(new Deliver()),
  fc.constant(new Deliver()),
  fc.constantFrom(100, 900).map((ms) => new Advance(ms)),
  fc.constant(new Unmount())
];

const outcomes = fc.record({
  apply: fc.array(fc.constantFrom<ApplyOutcome>("ok", "ok", "signing_failed", "git_failed"), { minLength: 1, maxLength: 4 }),
  check: fc.array(fc.constantFrom<CheckOutcome>("clean", "clean", "conflict"), { minLength: 1, maxLength: 4 })
});

async function runScenario(
  s: fc.Scheduler,
  generated: Outcomes,
  cmds: Iterable<Command>
): Promise<void> {
  mocks.dispatch.mockReset();
  mocks.clear.mockReset();
  const container = document.createElement("div");
  document.body.append(container);
  const w: World = {
    s,
    root: createRoot(container),
    container,
    props: { worktreeId: "wt-1", sourceHead: "head-0", selection: 0, op: "reorder" },
    context: 0,
    unmounted: false,
    appliedIn: new Set(),
    violations: [],
    counts: { apply: 0, check: 0 }
  };
  world = w;
  route(w, generated);
  await renderTab(w);
  await fc.asyncModelRun(() => ({ model: { unmounted: false }, real: w }), cmds);
  // Whatever is still in flight arrives, and every timer runs out.
  while (s.count() > 0) {
    await act(async () => {
      await s.waitOne();
    });
    await settle();
    assertInvariants(w);
  }
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  await settle();
  assertInvariants(w);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  const w = world;
  world = null;
  if (w !== null) {
    if (!w.unmounted) await act(async () => w.root.unmount());
    w.container.remove();
  }
  vi.useRealTimers();
});

async function cleanup(): Promise<void> {
  const w = world;
  world = null;
  if (w === null) return;
  if (!w.unmounted) {
    w.unmounted = true;
    await act(async () => w.root.unmount());
  }
  w.container.remove();
}

describe("RebaseTab async lifecycle (model)", () => {
  it("never shows a stale Apply or work after unmount", async () => {
    await fc.assert(
      fc
        .asyncProperty(fc.scheduler(), outcomes, fc.commands(commands, { size: "+1", maxCommands: 30 }), runScenario)
        .afterEach(cleanup),
      { numRuns: 100 }
    );
  });
});

// What the model shrank to against the code before #541 (04e4006^), kept so
// each regression has a name. It found each within 3–100 runs.
describe("RebaseTab async lifecycle (shrunk counterexamples)", () => {
  const scenario = async (cmds: Command[], generated: Partial<Outcomes> = {}): Promise<void> => {
    try {
      // Each step has at most one response in flight, so the order is fixed.
      await runScenario(
        fc.sample(fc.scheduler(), { numRuns: 1 })[0] as fc.Scheduler,
        { apply: ["ok"], check: ["clean"], ...generated },
        cmds
      );
    } finally {
      await cleanup();
    }
  };
  const check = new Click("Check", (w) => w.container.querySelector<HTMLButtonElement>(".rebase-check") ?? undefined);
  const apply = new Click("Apply", (w) => w.container.querySelector<HTMLButtonElement>(".rebase-apply") ?? undefined);
  it("Check, Apply, select another range, Apply answers: not Applied there", async () => {
    await scenario([check, new Deliver(), apply, new Show({ selection: 1 }, "select #1"), new Deliver()]);
  });

  it("Check, Apply, HEAD moves, Apply answers: no Applied and no Clear", async () => {
    await scenario([check, new Deliver(), apply, new Show({ sourceHead: "head-moved" }, "change HEAD"), new Deliver()]);
  });

  it("Check, Apply, unmount: the late success schedules no Clear", async () => {
    await scenario([check, new Deliver(), apply, new Unmount()]);
  });
});
