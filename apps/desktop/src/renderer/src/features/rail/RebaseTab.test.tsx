// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  err,
  ok
} from "@pwrgit/shared";

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
const proof = { commitCount: 3, resultCount: 1, steps: 3, tree: "4c1f9e0".padEnd(40, "0"), durationMs: 600 };

type Handler = (req: Record<string, unknown>) => unknown;

function route(overrides: Record<string, Handler>): void {
  mocks.dispatch.mockImplementation(async (name: string, req: Record<string, unknown>) => {
    const handler = overrides[name];
    if (handler !== undefined) return handler(req);
    switch (name) {
      case "graph:log":
        return ok({ commits: log });
      case "rebase:draft":
        return ok({ op: req["op"], valid: true, summary: "→ 1 commit", steps: [] });
      default:
        return ok(null);
    }
  });
}

let container: HTMLDivElement;
let root: Root;

async function render(
  op: "squash" | "reorder",
  selectedHashes = log.map((c) => c.hash),
  props: Partial<ComponentProps<typeof RebaseTab>> = {}
): Promise<void> {
  await act(async () => {
    root.render(
      <RebaseTab
        worktreeId="wt-1"
        sourceHead="head"
        selectedHashes={selectedHashes}
        op={op}
        branch="feat/csv-export"
        onClear={mocks.clear}
        {...props}
      />
    );
  });
  // Let the selection and plan requests settle.
  for (let i = 0; i < 5; i++) await act(async () => undefined);
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((r) => { resolve = r; });
  return { promise, resolve };
}

const cleanCheck = () =>
  ok({ status: "clean", approvalToken: "token-1", sourceHead: "head", message: "ok", proof });

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name
  );
  if (found === undefined) {
    throw new Error(
      `no button "${name}"; saw ${[...container.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`
    );
  }
  return found;
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>(".msg-box__input");
  if (el === null) throw new Error("no message box");
  return el;
}

async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function calls(name: string): Record<string, unknown>[] {
  return mocks.dispatch.mock.calls
    .filter(([command]) => command === name)
    .map(([, req]) => req as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("rebase tool copy", () => {
  it("explains the safe path before anything is selected", () => {
    const panel = renderToStaticMarkup(
      <RebaseTab worktreeId={null} sourceHead={null} selectedHashes={[]} op={null} onClear={() => undefined} />
    );
    expect(panel).toContain("Rebase tool");
    expect(panel).toContain("Isolated check · hooks off, nothing signed");
    expect(panel).toContain("inspect the");
  });
});

describe("Squash", () => {
  // Rule: the plan is for exactly the selected run. graph:log's default
  // window (200) cut a longer run to its newest 200 commits, which still
  // passed main's check as a run of their own and was rewritten instead.
  it("reads exactly the run's length and never drafts a subset of it", async () => {
    route({
      "graph:log": (req) => ok({ commits: log.slice(0, Number(req["limit"] ?? 200)) })
    });
    const gone = h("z");
    await render("reorder", [h("c"), h("b"), gone]);

    expect(calls("graph:log")[0]?.["limit"]).toBe(3);
    const drafted = calls("rebase:draft")[0]?.["commits"] as { hash: string }[];
    expect(drafted.map((c) => c.hash)).toEqual([h("c"), h("b"), gone]);
  });

  it("starts with joined subjects and applies the edited message after Check", async () => {
    route({
      "rebase:check": () =>
        ok({ status: "clean", approvalToken: "token-1", sourceHead: "head", message: "ok", proof })
    });
    await render("squash");

    expect(textarea().value).toBe("add CSV exporter\n\nwip\n\nfix lint");
    expect(container.textContent).toContain("3 → 1 · feat/csv-export");

    await act(async () => button("Check in isolated copy").click());
    expect(calls("rebase:check")[0]?.["program"]).toEqual({
      commits: [
        {
          members: [h("a"), h("b"), h("c")],
          message: "add CSV exporter\n\nwip\n\nfix lint"
        }
      ]
    });
    expect(container.textContent).toContain("tree 4c1f9e0");

    // Clearing the message disables Apply until a usable message is supplied.
    await type(textarea(), " ");
    expect(button("Apply rebase").disabled).toBe(true);

    // A message edit after the check keeps the approval: messages are data.
    await type(textarea(), "feat(export): edited after the check");
    expect(button("Apply rebase").disabled).toBe(false);
    await act(async () => button("Apply rebase").click());
    expect(calls("rebase:apply")[0]).toEqual(
      expect.objectContaining({
        approvalToken: "token-1",
        program: {
          commits: [{ members: [h("a"), h("b"), h("c")], message: "feat(export): edited after the check" }]
        }
      })
    );
  });

  it("blocks a plan that changes code, with no way to apply it", async () => {
    route({
      "rebase:check": () =>
        ok({
          status: "snag",
          code: "tree_changed",
          message:
            "The rewrite would change the code, not just the history, so it can't be applied. The worktree was not changed.",
          detail: { kind: "tree_changed", files: [{ path: "src/export/csv.ts", added: 2, removed: 2 }] }
        })
    });
    await render("reorder");
    await act(async () => button("Check in isolated copy").click());

    expect(container.querySelector(".rebase-check-result--bad > span")?.textContent).toBe("Blocked");
    expect(container.textContent).toContain("so it can't be applied");
    expect(container.textContent).toContain("Code changed in 1 file");
    expect(container.textContent).toContain("csv.ts +2 −2");
    expect(button("Apply rebase").disabled).toBe(true);
  });

});

describe("Apply lifecycle", () => {
  const nextSelection = log.slice(0, 2).map((c) => c.hash);

  it.each([
    ["selection", nextSelection, {}],
    ["worktree", log.map((c) => c.hash), { worktreeId: "wt-2" }],
    ["HEAD", log.map((c) => c.hash), { sourceHead: "new-head" }]
  ] as const)("ignores an Apply success after the %s changes", async (_label, hashes, props) => {
    vi.useFakeTimers();
    const pending = deferred();
    route({ "rebase:check": cleanCheck, "rebase:apply": () => pending.promise });
    await render("reorder");
    await act(async () => button("Check in isolated copy").click());
    await act(async () => button("Apply rebase").click());
    expect(button("Applying…").disabled).toBe(true);
    await render("reorder", [...hashes], props);
    await act(async () => pending.resolve(ok({})));

    expect(container.textContent).not.toContain("Applied locally");
    expect(button("Apply rebase").disabled).toBe(true);
    expect(button("Check in isolated copy").disabled).toBe(false);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(mocks.clear).not.toHaveBeenCalled();
    await act(async () => button("Check in isolated copy").click());
    expect(button("Apply rebase").disabled).toBe(false);
  });

  it.each(["git_failed", "signing_failed"])("drops an old %s error without replacing the new check", async (code) => {
    const pending = deferred();
    route({ "rebase:check": cleanCheck, "rebase:apply": () => pending.promise });
    await render("reorder");
    await act(async () => button("Check in isolated copy").click());
    await act(async () => button("Apply rebase").click());
    await render("reorder", nextSelection);
    expect(button("Check in isolated copy").disabled).toBe(false);
    await act(async () => button("Check in isolated copy").click());
    await act(async () => pending.resolve(err({ kind: "git", code, message: "Old apply failed." })));
    expect(container.textContent).not.toContain("Old apply failed.");
    expect(container.textContent).not.toContain("Apply without signing");
    expect(button("Apply rebase").disabled).toBe(false);
  });

  it("keeps a new Apply pending when an old unsigned retry finishes", async () => {
    vi.useFakeTimers();
    const unsigned = deferred();
    const current = deferred();
    route({
      "rebase:check": (req) => ok({ status: "clean", approvalToken: `token-${req["worktreeId"]}`, sourceHead: "head", message: "ok", proof }),
      "rebase:apply": () => {
        const count = calls("rebase:apply").length;
        if (count === 1) return err({ kind: "git", code: "signing_failed", message: "Signing failed." });
        if (count === 2) return unsigned.promise;
        return current.promise;
      }
    });
    await render("reorder");
    await act(async () => button("Check in isolated copy").click());
    await act(async () => button("Apply rebase").click());
    await act(async () => button("Apply without signing, this once").click());
    expect(calls("rebase:apply")[1]).toEqual(expect.objectContaining({ unsigned: true, approvalToken: "token-wt-1" }));

    await render("reorder", nextSelection, { worktreeId: "wt-2" });
    expect(button("Check in isolated copy").disabled).toBe(false);
    await act(async () => button("Check in isolated copy").click());
    await act(async () => button("Apply rebase").click());
    await act(async () => unsigned.resolve(ok({})));
    expect(button("Applying…").disabled).toBe(true);
    expect(container.textContent).not.toContain("Applied locally");
    await act(async () => vi.advanceTimersByTime(1000));
    expect(mocks.clear).not.toHaveBeenCalled();

    await act(async () => current.resolve(ok({})));
    expect(calls("rebase:apply")[2]).toEqual(expect.objectContaining({ worktreeId: "wt-2", approvalToken: "token-wt-2", commits: log.slice(0, 2) }));
    expect(calls("rebase:apply")[2]?.["unsigned"]).toBeUndefined();
    expect(container.textContent).toContain("Applied locally · 2 commits");
    await act(async () => vi.advanceTimersByTime(899));
    expect(mocks.clear).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(mocks.clear).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("does not clear after unmount (Apply already completed: %s)", async (completed) => {
    vi.useFakeTimers();
    const pending = deferred();
    route({ "rebase:check": cleanCheck, "rebase:apply": () => pending.promise });
    await render("reorder");
    await act(async () => button("Check in isolated copy").click());
    await act(async () => button("Apply rebase").click());
    if (completed) await act(async () => pending.resolve(ok({})));
    await act(async () => root.unmount());
    if (!completed) await act(async () => pending.resolve(ok({})));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("cancels a completed Apply's delayed clear when a new selection arrives", async () => {
    vi.useFakeTimers();
    route({ "rebase:check": cleanCheck, "rebase:apply": () => ok({}) });
    await render("reorder");
    await act(async () => button("Check in isolated copy").click());
    await act(async () => button("Apply rebase").click());
    expect(container.textContent).toContain("Applied locally · 3 commits");
    await act(async () => vi.advanceTimersByTime(899));
    await render("reorder", nextSelection);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(button("Check in isolated copy").disabled).toBe(false);
  });
});
