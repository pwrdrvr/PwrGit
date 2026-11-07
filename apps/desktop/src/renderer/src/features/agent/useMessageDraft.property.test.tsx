// @vitest-environment jsdom

/**
 * A model test for the message box's agent half (`useMessageDraft`, used by
 * Squash and the commit box), the same request-id lifecycle RebaseTab's Tidy
 * had before #541. Random sequences of Draft, Cancel, typing, Use draft,
 * Undo, a new selection and unmount run against the real hook and footer;
 * fc.scheduler decides when each draft arrives. Main is simulated as it
 * behaves (agent-handlers.ts): a cancel turns an unanswered request into
 * `cancelled`, but a draft main already sent still arrives.
 *
 * Rules:
 * - Explicit Cancel is terminal: the footer never says "reading" after it,
 *   and a draft that arrives after it never fills the box.
 * - "reading" shows only while a request is outstanding and not cancelled.
 * - The box and "Use draft" only ever hold a draft asked for this selection.
 * - What the operator typed is never overwritten by an arriving draft.
 * - Once unmounted, nothing asks main for anything.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { afterEach, describe, it, vi } from "vitest";
import { err, ok, type AgentMessageDraft } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: () => () => undefined,
  windowProfileId: () => "work"
}));

import { DraftFooter } from "./DraftFooter";
import { draftText, useMessageDraft, type MessageDraft } from "./useMessageDraft";

const h = (id: string): string => id.repeat(40);
const SELECTIONS = [
  [h("c"), h("b"), h("a")],
  [h("c"), h("b")]
];

type Props = { worktreeId: string; selection: number };
type Outcome = "ok" | "failed" | "answered";

type Request = { context: number; cancelled: boolean; settled: boolean };
type World = {
  s: fc.Scheduler;
  root: Root;
  container: HTMLDivElement;
  props: Props;
  autoStart: boolean;
  context: number;
  unmounted: boolean;
  hook: MessageDraft | null;
  requests: Map<string, Request>;
  /** Draft subject → the selection it may show in. */
  allowed: Map<string, number>;
  /** What the operator last typed, until something else may change the box. */
  typed: string | null;
  violations: string[];
  n: number;
};
type Model = { unmounted: boolean };

let world: World | null = null;

function Harness({ w, props }: { w: World; props: Props }) {
  const { worktreeId, selection } = props;
  const hashes = SELECTIONS[selection] ?? [];
  const draft = useMessageDraft({
    worktreeId,
    source: { kind: "commits", commits: hashes.map((hash) => ({ hash, subject: `subject ${hash[0]}` })) },
    fallback: `joined ${worktreeId} #${selection}`,
    autoStart: w.autoStart,
    ready: true
  });
  w.hook = draft;
  return (
    <DraftFooter
      draft={draft}
      agentName="Codex"
      agentReady
      fallbackLabel="Joined from subjects"
      fallbackAction="Use subjects"
      unitLabel={`${hashes.length} diffs`}
    />
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(async () => undefined);
}

async function renderHarness(w: World): Promise<void> {
  await act(async () => w.root.render(<Harness w={w} props={w.props} />));
  await settle();
}

function drafting(w: World): boolean {
  return /Codex is reading/.test(w.container.textContent ?? "");
}

function assertInvariants(w: World): void {
  if (w.violations.length > 0) throw new Error(w.violations.join("\n"));
  if (w.unmounted || w.hook === null) return;
  const hook = w.hook;
  if (drafting(w) && ![...w.requests.values()].some((r) => !r.settled && !r.cancelled)) {
    throw new Error("says Codex is reading with no request outstanding");
  }
  if (hook.draft !== null && w.allowed.get(hook.draft.subject) !== w.context) {
    throw new Error(`holds draft "${hook.draft.subject}", which was cancelled or asked for another selection`);
  }
  if (hook.origin === "agent") {
    const fromAllowed = [...w.allowed].some(
      ([subject, context]) => context === w.context && hook.text === draftText({ subject, body: "Body." } as AgentMessageDraft)
    );
    if (!fromAllowed) throw new Error(`the box holds "${hook.text}", not a draft for this selection`);
  }
  if (w.typed !== null && hook.text !== w.typed) {
    throw new Error(`overwrote what the operator typed ("${w.typed}") with "${hook.text}"`);
  }
}

function route(w: World, outcomes: Outcome[]): void {
  mocks.dispatch.mockImplementation((name: string, req: Record<string, unknown>) => {
    if (w.unmounted) w.violations.push(`dispatched ${name} after unmount`);
    if (name === "agent:cancel") {
      const r = w.requests.get(String(req["requestId"]));
      const cancelled = r !== undefined && !r.settled;
      if (r !== undefined) r.cancelled = true;
      return Promise.resolve(ok({ cancelled }));
    }
    if (name !== "agent:draftMessage") return Promise.resolve(ok(null));
    const id = String(req["requestId"]);
    const r: Request = { context: w.context, cancelled: false, settled: false };
    w.requests.set(id, r);
    const n = w.n++;
    const outcome = outcomes[n % outcomes.length] ?? "ok";
    const subject = `draft ${n}`;
    const draft: AgentMessageDraft = {
      requestId: id,
      providerId: "codex",
      providerName: "Codex",
      model: "gpt-5.5",
      saw: { source: "commits", commitCount: 2, files: [], budget: { used: 1, limit: 2000 }, styleSubjects: 0 },
      style: { convention: "conventional", matched: 0, sampled: 0 },
      generatedAt: "2026-09-19T12:00:00.000Z",
      subject,
      body: "Body."
    };
    // "answered": main had already sent the draft when a cancel arrived, so
    // the cancel finds nothing to abort and the draft still lands.
    const cancelledBeforeAnswer = (): boolean => r.cancelled && outcome !== "answered";
    return w.s.schedule(Promise.resolve(outcome), `draft ${n} ${outcome}`).then(() => {
      r.settled = true;
      if (cancelledBeforeAnswer()) return err({ kind: "agent", code: "cancelled", message: "Cancelled. Nothing changed." });
      if (outcome === "failed") return err({ kind: "agent", code: "failed", message: "Codex failed." });
      if (!r.cancelled) w.allowed.set(subject, r.context);
      return ok(draft);
    });
  });
}

type Command = fc.AsyncCommand<Model, World>;

class Show implements Command {
  constructor(readonly next: Props) {}
  check = (m: Readonly<Model>) => !m.unmounted;
  async run(_m: Model, w: World): Promise<void> {
    if (this.next.worktreeId !== w.props.worktreeId || this.next.selection !== w.props.selection) {
      w.context += 1;
      w.typed = null;
    }
    w.props = this.next;
    await renderHarness(w);
    assertInvariants(w);
  }
  toString = () => `select ${this.next.worktreeId} #${this.next.selection}`;
}

class Click implements Command {
  constructor(readonly label: string) {}
  check = (m: Readonly<Model>) => !m.unmounted;
  async run(_m: Model, w: World): Promise<void> {
    const el = [...w.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === this.label);
    if (el === undefined) return;
    w.typed = null;
    await act(async () => el.click());
    await settle();
    if (this.label === "Cancel" && drafting(w)) throw new Error("still reading after Cancel");
    assertInvariants(w);
  }
  toString = () => `click ${this.label}`;
}

class Type implements Command {
  check = (m: Readonly<Model>) => !m.unmounted;
  async run(_m: Model, w: World): Promise<void> {
    const text = `typed ${w.n}-${w.context}`;
    await act(async () => w.hook?.setText(text));
    w.typed = text;
    await settle();
    assertInvariants(w);
  }
  toString = () => "type";
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

const commands = [
  fc
    .record({ worktreeId: fc.constantFrom("wt-1", "wt-2"), selection: fc.integer({ min: 0, max: SELECTIONS.length - 1 }) })
    .map((p) => new Show(p)),
  fc.constantFrom("Draft", "Retry", "Regenerate", "Use draft", "Use subjects", "Undo").map((l) => new Click(l)),
  fc.constant(new Click("Cancel")),
  fc.constant(new Click("Cancel")),
  fc.constant(new Type()),
  fc.constant(new Deliver()),
  fc.constant(new Deliver()),
  fc.constant(new Unmount())
];

async function runScenario(
  s: fc.Scheduler,
  autoStart: boolean,
  outcomes: Outcome[],
  cmds: Iterable<Command>
): Promise<void> {
  mocks.dispatch.mockReset();
  const container = document.createElement("div");
  document.body.append(container);
  const w: World = {
    s,
    root: createRoot(container),
    container,
    props: { worktreeId: "wt-1", selection: 0 },
    autoStart,
    context: 0,
    unmounted: false,
    hook: null,
    requests: new Map(),
    allowed: new Map(),
    typed: null,
    violations: [],
    n: 0
  };
  world = w;
  route(w, outcomes);
  await renderHarness(w);
  await fc.asyncModelRun(() => ({ model: { unmounted: false }, real: w }), cmds);
  while (s.count() > 0) {
    await act(async () => {
      await s.waitOne();
    });
    await settle();
    assertInvariants(w);
  }
}

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

afterEach(cleanup);

describe("useMessageDraft lifecycle (model)", () => {
  it("never shows a cancelled or stale draft, or reads after Cancel", async () => {
    await fc.assert(
      fc
        .asyncProperty(
          fc.scheduler(),
          fc.boolean(),
          fc.array(fc.constantFrom<Outcome>("ok", "ok", "failed", "answered"), { minLength: 1, maxLength: 4 }),
          fc.commands(commands, { size: "+1", maxCommands: 30 }),
          runScenario
        )
        .afterEach(cleanup),
      { numRuns: 100 }
    );
  });
});

// What the model shrank to against the hook before Cancel was made terminal,
// kept so each regression has a name. Both found within 2 runs.
describe("useMessageDraft lifecycle (shrunk counterexamples)", () => {
  const scenario = async (autoStart: boolean, outcomes: Outcome[], cmds: Command[]): Promise<void> => {
    // One draft in flight, so the order is fixed.
    await runScenario(fc.sample(fc.scheduler(), { numRuns: 1 })[0] as fc.Scheduler, autoStart, outcomes, cmds);
  };

  it("auto-draft, Cancel: no longer reading", async () => {
    await scenario(true, ["ok"], [new Click("Cancel")]);
  });

  it("auto-draft, Cancel after main already answered: the draft does not fill the box", async () => {
    await scenario(true, ["answered"], [new Click("Cancel")]);
  });
});
