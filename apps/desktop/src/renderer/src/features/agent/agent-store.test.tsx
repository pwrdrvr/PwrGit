// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type AgentAvailability, type AgentJobState } from "@pwrgit/shared";

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

import { resetAgentStore, useAgentOffered } from "./agent-store";

function availability(state: AgentJobState): AgentAvailability {
  const status = (jobId: "commitMessage" | "historyEditing") => ({
    jobId,
    state,
    message: state === "ready" ? "" : `not ${state}`,
    providerName: state === "ready" ? "Codex" : null,
    model: null,
    modelLabel: null,
    effort: null
  });
  return {
    profileId: "work",
    jobs: { commitMessage: status("commitMessage"), historyEditing: status("historyEditing") }
  };
}

function TidyEntry() {
  return <span>{useAgentOffered("historyEditing") ? "offered" : "hidden"}</span>;
}

let container: HTMLDivElement;
let root: Root;
let answer: (() => Promise<unknown>) | null;

async function render(): Promise<void> {
  await act(async () => root.render(<TidyEntry />));
  for (let i = 0; i < 3; i++) await act(async () => undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.clear();
  resetAgentStore();
  answer = null;
  mocks.dispatch.mockImplementation(async (name: string) =>
    name === "agent:availability" && answer !== null ? answer() : ok(null)
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useAgentOffered", () => {
  it("hides the entry point until the answer is in, so AI off never flashes it", async () => {
    answer = () => new Promise(() => undefined);
    await render();
    expect(container.textContent).toBe("hidden");
  });

  it("hides it with AI off and offers it whenever AI is on", async () => {
    answer = async () => ok(availability("disabled"));
    await render();
    expect(container.textContent).toBe("hidden");

    // Signed out is still on: the Tidy footer says why and where to fix it.
    answer = async () => ok(availability("signed_out"));
    await act(async () => mocks.events.get("aiProviders:changed")?.({ profileId: "work", settings: {} }));
    for (let i = 0; i < 3; i++) await act(async () => undefined);
    expect(container.textContent).toBe("offered");
  });

  it("asks once per window however many surfaces want the answer", async () => {
    answer = async () => ok(availability("ready"));
    await act(async () =>
      root.render(
        <>
          <TidyEntry />
          <TidyEntry />
        </>
      )
    );
    for (let i = 0; i < 3; i++) await act(async () => undefined);
    expect(container.textContent).toBe("offeredoffered");
    expect(mocks.dispatch.mock.calls.filter(([name]) => name === "agent:availability")).toEqual([
      ["agent:availability", { profileId: "work" }]
    ]);
  });
});
