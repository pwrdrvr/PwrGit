// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  err,
  ok,
  type AgentAvailability,
  type AgentJobState,
  type AgentJobStatus,
  type AgentMessageDraft,
  type AgentTidyProposal,
  type AiJobId,
  type CodexModelOption,
  type HistoryEditProgram
} from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  events: new Map<string, (payload: unknown) => void>()
}));
vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: (channel: string, handler: (payload: unknown) => void) => {
    mocks.events.set(channel, handler);
    return () => mocks.events.delete(channel);
  },
  windowProfileId: () => "work"
}));

import { SelectionBar } from "../graph/SelectionBar";
import { resetAgentStore } from "../agent/agent-store";
import { RebaseTab } from "./RebaseTab";

const h = (id: string): string => id.repeat(40);
// Newest first, as graph:log lists them.
const log = [
  { hash: h("c"), subject: "fix lint" },
  { hash: h("b"), subject: "wip" },
  { hash: h("a"), subject: "add CSV exporter" }
];
const proof = { commitCount: 3, resultCount: 1, steps: 3, tree: "4c1f9e0".padEnd(40, "0"), durationMs: 600 };

function job(
  jobId: AiJobId,
  state: AgentJobState,
  message: string,
  overrides: Partial<AgentJobStatus>
): AgentJobStatus {
  return {
    jobId,
    state,
    message,
    providerName: state === "ready" ? "Codex" : null,
    model: null,
    modelLabel: null,
    effort: null,
    ...overrides
  };
}

/** Both jobs answer alike: they share a profile's switch and its Codex. */
function availability(
  state: AgentJobState,
  message = "",
  overrides: Partial<AgentJobStatus> = {}
): AgentAvailability {
  return {
    profileId: "work",
    jobs: {
      commitMessage: job("commitMessage", state, message, overrides),
      historyEditing: job("historyEditing", state, message, overrides)
    }
  };
}

const ready = availability("ready");
const unavailable = availability(
  "unavailable",
  "History editing needs Codex, and no usable Codex CLI was found."
);
const signedOut = availability("signed_out", "Codex is not signed in for the default account.");
const off = availability(
  "disabled",
  "AI features are off for this profile. Turn them on from the AI switch at the bottom of the sidebar."
);

function codexModel(id: string, displayName: string, overrides: Partial<CodexModelOption> = {}): CodexModelOption {
  return {
    id,
    model: id,
    displayName,
    description: "",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
    isDefault: false,
    ...overrides
  };
}

const base = {
  providerId: "codex",
  providerName: "Codex",
  model: "gpt-5.5",
  saw: {
    source: "commits" as const,
    commitCount: 3,
    files: [{ path: "src/export.ts", added: 12, removed: 3, treatment: "sent" as const, sentLines: 30, totalLines: 30 }],
    budget: { used: 30, limit: 2000 },
    styleSubjects: 20
  },
  style: { convention: "conventional" as const, matched: 18, sampled: 20 },
  generatedAt: "2026-09-19T12:00:00.000Z"
};

function message(requestId: string): AgentMessageDraft {
  return { ...base, requestId, subject: "feat(export): add CSV exporter", body: "Why it exists." };
}

function tidyProposal(requestId: string, program: HistoryEditProgram, note: string | null): AgentTidyProposal {
  return { ...base, requestId, program, note };
}

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
      case "agent:availability":
        return ok(ready);
      case "agent:cancel":
        return ok({ cancelled: true });
      default:
        return ok(null);
    }
  });
}

let container: HTMLDivElement;
let root: Root;

async function render(
  op: "squash" | "reorder" | "tidy",
  selectedHashes = log.map((c) => c.hash)
): Promise<void> {
  await act(async () => {
    root.render(
      <RebaseTab
        worktreeId="wt-1"
        sourceHead="head"
        selectedHashes={selectedHashes}
        op={op}
        branch="feat/csv-export"
        onClear={() => undefined}
      />
    );
  });
  // Let the selection, plan and agent requests settle.
  for (let i = 0; i < 5; i++) await act(async () => undefined);
}

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

function chip(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(".agent-chip");
  if (el === null) throw new Error("no agent chip");
  return el;
}

function menu(): HTMLElement {
  const el = container.querySelector<HTMLElement>(".agent-menu");
  if (el === null) throw new Error("the agent menu is closed");
  return el;
}

function menuItem(model: string): HTMLButtonElement {
  const found = [...menu().querySelectorAll<HTMLButtonElement>("button.agent-menu__item")].find(
    (item) => item.querySelector(".agent-menu__model")?.textContent === model
  );
  if (found === undefined) throw new Error(`no model "${model}" in the menu`);
  return found;
}

function effortLabels(): string[] {
  return [...menu().querySelectorAll(".agent-menu__seg button")].map((b) => b.textContent ?? "");
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
  mocks.events.clear();
  resetAgentStore();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("rebase tool copy", () => {
  it("explains the safe path before anything is selected", () => {
    const panel = renderToStaticMarkup(
      <RebaseTab worktreeId={null} sourceHead={null} selectedHashes={[]} op={null} onClear={() => undefined} />
    );
    expect(panel).toContain("Rebase tool");
    expect(panel).toContain("Isolated check · hooks and signing disabled");
    expect(panel).toContain("inspect the");
  });

  it("offers Tidy on the selection bar only where a handler is wired", () => {
    const props = {
      count: 2,
      onSquash: () => undefined,
      onReorder: () => undefined,
      onOpenRebaseTool: () => undefined,
      onClear: () => undefined
    };
    expect(renderToStaticMarkup(<SelectionBar {...props} onTidy={() => undefined} />)).toContain("Tidy…");
    expect(renderToStaticMarkup(<SelectionBar {...props} />)).not.toContain("Tidy…");
  });
});

describe("Squash with an agent", () => {
  it("drafts the message, then checks and applies whatever the box says", async () => {
    route({
      "agent:draftMessage": (req) => ok(message(String(req["requestId"]))),
      "rebase:check": () =>
        ok({ status: "clean", approvalToken: "token-1", sourceHead: "head", message: "ok", proof })
    });
    await render("squash");

    expect(textarea().value).toBe("feat(export): add CSV exporter\n\nWhy it exists.");
    expect(container.textContent).toContain("Codex, from 3 diffs");
    expect(container.textContent).toContain("conventional commits");
    expect(container.textContent).toContain("Saw 3 diffs · 1 file · 30 lines");
    expect(container.textContent).toContain("3 → 1 · feat/csv-export");
    expect(calls("agent:draftMessage")[0]?.["source"]).toEqual({ kind: "commits", commits: log });

    await act(async () => button("Check in isolated copy").click());
    expect(calls("rebase:check")[0]?.["program"]).toEqual({
      commits: [
        {
          members: [h("a"), h("b"), h("c")],
          message: "feat(export): add CSV exporter\n\nWhy it exists."
        }
      ]
    });
    expect(container.textContent).toContain("tree 4c1f9e0");

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

  it("never overwrites what the operator typed; the draft waits behind Use draft", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    route({
      "agent:draftMessage": (req) =>
        new Promise((r) => {
          resolve = () => r(ok(message(String(req["requestId"]))));
        })
    });
    await render("squash");
    expect(container.textContent).toContain("Codex is reading 3 diffs…");
    // Joined subjects hold the box while the draft is out.
    expect(textarea().value).toBe("add CSV exporter\n\nwip\n\nfix lint");

    await type(textarea(), "mine");
    await act(async () => resolve(undefined));
    expect(textarea().value).toBe("mine");
    expect(container.textContent).toContain("Codex draft ready");

    await act(async () => button("Use draft").click());
    expect(textarea().value).toContain("feat(export): add CSV exporter");
    await act(async () => button("Undo").click());
    expect(textarea().value).toBe("mine");
  });

  it("says a timeout once, in the footer, and offers Retry", async () => {
    route({
      "agent:draftMessage": () =>
        err({ kind: "agent", code: "timeout", message: "Codex did not finish in time. Nothing changed." })
    });
    await render("squash");
    expect(container.textContent).toMatch(/Codex stopped after \d+ s\. Nothing changed\./);
    expect(button("Retry")).toBeDefined();
    expect(button("Check in isolated copy").disabled).toBe(false);
  });
});

describe("Squash with no agent", () => {
  it("works from the joined subjects and points at AI Providers", async () => {
    route({ "agent:availability": () => ok(unavailable) });
    await render("squash");

    expect(textarea().value).toBe("add CSV exporter\n\nwip\n\nfix lint");
    expect(container.textContent).toContain("Joined from 3 subjects");
    expect(container.textContent).toContain("No agent");
    expect(calls("agent:draftMessage")).toHaveLength(0);

    await act(async () => button("Draft with an agent…").click());
    expect(calls("settings:open")).toEqual([{ page: "ai-providers", profileId: "work" }]);

    await act(async () => chip().click());
    expect(menu().textContent).toContain(
      "History editing needs Codex, and no usable Codex CLI was found."
    );
  });
});

describe("Squash with AI off", () => {
  it("is Git's joined subjects and nothing else: no request, no agent link", async () => {
    route({ "agent:availability": () => ok(off) });
    await render("squash");

    expect(textarea().value).toBe("add CSV exporter\n\nwip\n\nfix lint");
    expect(container.textContent).toContain("Joined from 3 subjects");
    expect(container.textContent).not.toContain("Draft with an agent");
    expect(calls("agent:draftMessage")).toHaveLength(0);
    expect(chip().textContent).toContain("AI off");
    expect(button("Check in isolated copy").disabled).toBe(false);

    await act(async () => chip().click());
    expect(menu().textContent).toContain("AI features are off");
    await act(async () => button("Open AI Features").click());
    expect(calls("settings:open")).toEqual([
      { page: "ai-features", sub: "availability", profileId: "work" }
    ]);
  });

  it("drafts on its own once AI is turned on for this profile, not another", async () => {
    let answer = off;
    route({
      "agent:availability": () => ok(answer),
      "agent:draftMessage": (req) => ok(message(String(req["requestId"])))
    });
    await render("squash");
    expect(calls("agent:draftMessage")).toHaveLength(0);

    answer = ready;
    const changed = mocks.events.get("aiProviders:changed");
    await act(async () => changed?.({ profileId: "home", settings: {} }));
    for (let i = 0; i < 3; i++) await act(async () => undefined);
    // Another profile's switch is not this window's.
    expect(calls("agent:availability")).toHaveLength(1);

    await act(async () => changed?.({ profileId: "work", settings: {} }));
    for (let i = 0; i < 3; i++) await act(async () => undefined);
    expect(calls("agent:availability")).toHaveLength(2);
    expect(calls("agent:draftMessage")).toHaveLength(1);
    expect(textarea().value).toBe("feat(export): add CSV exporter\n\nWhy it exists.");
  });
});

describe("The agent chip", () => {
  const models = [
    codexModel("gpt-5.5", "GPT-5.5", { isDefault: true }),
    codexModel("gpt-5.5-mini", "GPT-5.5 mini", { supportedReasoningEfforts: ["low", "medium"] }),
    codexModel("gpt-internal", "Internal", { hidden: true })
  ];

  it("starts from the Settings default and overrides it for this request only", async () => {
    route({
      "agent:availability": () =>
        ok(availability("ready", "", { model: "gpt-5.5", modelLabel: "GPT-5.5", effort: "high" })),
      "aiProviders:codexModels": () => ok({ models }),
      "agent:draftMessage": (req) => ok(message(String(req["requestId"])))
    });
    await render("squash");
    expect(chip().textContent).toContain("GPT-5.5");
    // The Settings default runs as it is: main applies it, not the request.
    expect(calls("agent:draftMessage")[0]?.["choice"]).toBeUndefined();

    await act(async () => chip().click());
    expect(calls("aiProviders:codexModels")).toEqual([{ profileId: "work" }]);
    expect(menu().textContent).not.toContain("Internal");
    expect(menu().textContent).toContain("Only this request. The default is in");
    await act(async () => menuItem("GPT-5.5 mini").click());
    expect(chip().textContent).toContain("GPT-5.5 mini");

    await act(async () => chip().click());
    // The picked model's own efforts, not every model's.
    expect(effortLabels()).toEqual(["Default", "Low", "Medium"]);
    await act(async () => button("Medium").click());
    await act(async () => button("Regenerate").click());
    expect(calls("agent:draftMessage")[1]?.["choice"]).toEqual({
      model: "gpt-5.5-mini",
      effort: "medium"
    });

    await act(async () => button("Settings › AI Features").click());
    expect(calls("settings:open")).toEqual([
      { page: "ai-features", sub: "default-agents", profileId: "work" }
    ]);

    // A new selection is a new request, back on the Settings default.
    await render("squash", log.slice(0, 2).map((c) => c.hash));
    expect(chip().textContent).not.toContain("mini");
    expect(calls("agent:draftMessage").at(-1)?.["choice"]).toBeUndefined();
  });

  it("drops an effort the newly picked model does not take", async () => {
    route({
      "aiProviders:codexModels": () => ok({ models }),
      "agent:draftMessage": (req) => ok(message(String(req["requestId"])))
    });
    await render("squash");
    await act(async () => chip().click());
    await act(async () => button("Xhigh").click());
    await act(async () => menuItem("GPT-5.5 mini").click());
    await act(async () => button("Regenerate").click());
    expect(calls("agent:draftMessage").at(-1)?.["choice"]).toEqual({ model: "gpt-5.5-mini" });
  });
});

describe("Tidy", () => {
  const first: HistoryEditProgram = {
    commits: [
      { members: [h("a"), h("c")], message: "feat(export): add CSV exporter" },
      { members: [h("b")], message: "test(export): cover quoting" }
    ]
  };
  const revised: HistoryEditProgram = {
    commits: [{ members: [h("a"), h("b"), h("c")], message: "feat(export): add CSV exporter" }]
  };

  it("asks on entry, revises after a conflict, and re-checks on its own", async () => {
    const conflict = {
      kind: "conflict" as const,
      step: 2,
      total: 3,
      hash: h("c"),
      subject: "fix lint",
      files: ["src/export.ts"]
    };
    let checks = 0;
    route({
      "agent:tidyPlan": (req) =>
        ok(
          req["revision"] === undefined
            ? tidyProposal(String(req["requestId"]), first, "Folded the lint fix into the exporter.")
            : tidyProposal(String(req["requestId"]), revised, "Kept the fix after the test it touches.")
        ),
      "rebase:check": () => {
        checks += 1;
        return ok(
          checks === 1
            ? { status: "snag", code: "conflict", message: "Tidy would hit a conflict. The worktree was not changed.", detail: conflict }
            : { status: "clean", approvalToken: "token-2", sourceHead: "head", message: "ok", proof }
        );
      }
    });
    await render("tidy");

    expect(calls("agent:tidyPlan")).toHaveLength(1);
    expect(container.textContent).toContain("Proposed history");
    expect(container.textContent).toContain("moved");
    expect(container.textContent).toContain("3 → 2 · feat/csv-export");

    await act(async () => button("Check in isolated copy").click());
    for (let i = 0; i < 5; i++) await act(async () => undefined);

    const revision = calls("agent:tidyPlan")[1]?.["revision"] as Record<string, unknown> | undefined;
    expect(revision?.["attempt"]).toBe(1);
    expect(revision?.["detail"]).toEqual(conflict);
    expect(revision?.["program"]).toEqual(first);
    expect(calls("rebase:check")[1]?.["program"]).toEqual(revised);
    expect(container.textContent).toContain("Codex revised the plan");
    expect(container.textContent).toContain("revision 1 of 2");
    expect(container.textContent).toContain("Kept the fix after the test it touches.");
    expect(button("Apply revised plan").disabled).toBe(false);
  });

  it("resets the check when a fold is kept separate", async () => {
    route({
      "agent:tidyPlan": (req) => ok(tidyProposal(String(req["requestId"]), first, null)),
      "rebase:check": () =>
        ok({ status: "clean", approvalToken: "token-3", sourceHead: "head", message: "ok", proof })
    });
    await render("tidy");
    await act(async () => button("Check in isolated copy").click());
    expect(button("Apply 2 commits").disabled).toBe(false);

    await act(async () => button("Keep separate").click());
    expect(button("Apply 3 commits").disabled).toBe(true);
    expect(button("Check in isolated copy").disabled).toBe(false);
  });

  it("discards a plan that changes code, with no way to apply it", async () => {
    route({
      "agent:tidyPlan": (req) => ok(tidyProposal(String(req["requestId"]), first, null)),
      "rebase:check": () =>
        ok({
          status: "snag",
          code: "tree_changed",
          message: "Tidy would change the code. It was discarded; the worktree was not changed.",
          detail: { kind: "tree_changed", files: [{ path: "src/export/csv.ts", added: 2, removed: 2 }] }
        })
    });
    await render("tidy");
    await act(async () => button("Check in isolated copy").click());

    expect(container.textContent).toContain("Discarded");
    expect(container.textContent).toContain("Code changed in 1 file");
    expect(container.textContent).toContain("csv.ts +2 −2");
    expect(button("Apply 2 commits").disabled).toBe(true);
    expect(button("Ask Codex for another plan").disabled).toBe(false);
  });

  it("says plainly that Tidy needs an agent when none is set up", async () => {
    route({ "agent:availability": () => ok(unavailable) });
    await render("tidy");
    expect(container.textContent).toContain("Tidy needs an agent. Squash and Reorder don't.");
    expect(calls("agent:tidyPlan")).toHaveLength(0);
    // No plan, nothing to check or apply: Discard is the only action.
    expect(container.querySelector(".rebase-apply")).toBeNull();
    expect(container.querySelector(".rebase-check")).toBeNull();
  });

  it("says why the agent cannot run, once, and where to fix it", async () => {
    route({ "agent:availability": () => ok(signedOut) });
    await render("tidy");
    expect(container.querySelector(".msg-foot")?.textContent).toContain(
      "Codex is not signed in for the default account."
    );
    await act(async () => button("Open AI Providers").click());
    expect(calls("settings:open")).toEqual([{ page: "ai-providers", profileId: "work" }]);
    expect(calls("agent:tidyPlan")).toHaveLength(0);
  });

  it("asks for nothing with AI off", async () => {
    route({ "agent:availability": () => ok(off) });
    await render("tidy");
    expect(container.textContent).toContain("AI features are off for this profile");
    expect(calls("agent:tidyPlan")).toHaveLength(0);
    expect(calls("aiProviders:codexModels")).toHaveLength(0);
  });
});
