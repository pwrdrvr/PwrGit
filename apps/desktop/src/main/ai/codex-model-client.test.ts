import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  shell: { openExternal: vi.fn(async () => undefined) }
}));

// A scripted App Server: no Codex is spawned. The real module's other exports
// stay, because the kit's discovery package imports them too.
const fake = vi.hoisted(() => {
  const state = {
    spawned: [] as unknown[],
    requests: [] as { method: string; params: unknown }[],
    closed: 0,
    answer: (_method: string, _params: unknown): unknown => ({})
  };
  class FakeTransport {
    constructor(options: unknown) {
      state.spawned.push(options);
    }
  }
  class FakeConnection {
    async connect(): Promise<void> {}
    async request(method: string, params?: unknown): Promise<unknown> {
      state.requests.push({ method, params });
      return state.answer(method, params);
    }
    async close(): Promise<void> {
      state.closed += 1;
    }
  }
  return { state, FakeTransport, FakeConnection };
});

vi.mock("@pwrdrvr/agent-transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pwrdrvr/agent-transport")>()),
  JsonRpcConnection: fake.FakeConnection,
  StdioJsonRpcTransport: fake.FakeTransport
}));

import { listCodexModels, toCodexModelOption } from "./codex-model-client";

describe("toCodexModelOption", () => {
  it("reads a complete model/list entry", () => {
    expect(
      toCodexModelOption({
        id: "gpt-5-codex",
        model: "gpt-5-codex",
        displayName: "GPT-5 Codex",
        description: "Tuned for code",
        hidden: false,
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
        isDefault: true
      })
    ).toEqual({
      id: "gpt-5-codex",
      model: "gpt-5-codex",
      displayName: "GPT-5 Codex",
      description: "Tuned for code",
      hidden: false,
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
      isDefault: true
    });
  });

  it("accepts efforts advertised as { reasoningEffort } records", () => {
    expect(
      toCodexModelOption({
        id: "gpt-5",
        supportedReasoningEfforts: [
          { reasoningEffort: "minimal", description: "Fastest" },
          { reasoningEffort: "high", description: "Deepest" }
        ]
      }).supportedReasoningEfforts
    ).toEqual(["minimal", "high"]);
  });

  it("drops malformed efforts and repeats rather than offering them", () => {
    expect(
      toCodexModelOption({
        id: "gpt-5",
        supportedReasoningEfforts: [
          "low",
          { reasoningEffort: "low" },
          "HIGH",
          "",
          "x".repeat(41),
          3,
          null,
          {},
          { reasoningEffort: 7 },
          "x_high-2"
        ]
      }).supportedReasoningEfforts
    ).toEqual(["low", "x_high-2"]);
  });

  it("offers no efforts when the build advertises none", () => {
    expect(toCodexModelOption({ id: "o3", supportedReasoningEfforts: "high" }).supportedReasoningEfforts).toEqual([]);
  });

  it("names a model by its id when the build sends nothing else", () => {
    expect(toCodexModelOption({ id: "o3" })).toEqual({
      id: "o3",
      model: "o3",
      displayName: "o3",
      description: "",
      hidden: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      isDefault: false
    });
  });

  it("reads hidden and isDefault only as real booleans", () => {
    const option = toCodexModelOption({ id: "o3", hidden: "true", isDefault: 1 });
    expect(option.hidden).toBe(false);
    expect(option.isDefault).toBe(false);
  });

  it("drops a malformed default effort", () => {
    expect(toCodexModelOption({ id: "o3", defaultReasoningEffort: "Medium" }).defaultReasoningEffort).toBeNull();
  });

  it("answers an id-less option for a non-record, which the lister then skips", () => {
    expect(toCodexModelOption(null).id).toBe("");
    expect(toCodexModelOption("gpt-5").id).toBe("");
  });
});

describe("listCodexModels", () => {
  afterEach(() => {
    fake.state.spawned = [];
    fake.state.requests = [];
    fake.state.closed = 0;
    fake.state.answer = () => ({});
  });

  const modelListCalls = () =>
    fake.state.requests.filter((request) => request.method === "model/list");

  it("starts the App Server under the given env and pages until the cursor runs out", async () => {
    fake.state.answer = (method, params) => {
      if (method !== "model/list") return {};
      const cursor = (params as { cursor: string | null }).cursor;
      return cursor === null
        ? { data: [{ id: "gpt-5" }, { id: "" }, "junk"], nextCursor: "page-2" }
        : { data: [{ id: "o3" }], nextCursor: null };
    };
    const env = { CODEX_HOME: "/home/me/.codex/profiles/work" };

    const models = await listCodexModels({ command: "/bin/codex", env, includeHidden: false });

    expect(models.map((model) => model.id)).toEqual(["gpt-5", "o3"]);
    expect(fake.state.spawned[0]).toMatchObject({ command: "/bin/codex", args: ["app-server"], env });
    expect(fake.state.requests[0]?.method).toBe("initialize");
    expect(modelListCalls().map((call) => call.params)).toEqual([
      { cursor: null, limit: 100, includeHidden: false },
      { cursor: "page-2", limit: 100, includeHidden: false }
    ]);
    expect(fake.state.closed).toBe(1);
  });

  it("stops after twenty pages when the cursor never ends", async () => {
    let page = 0;
    fake.state.answer = (method) => {
      if (method !== "model/list") return {};
      page += 1;
      return { data: [{ id: `m-${page}` }], nextCursor: "again" };
    };

    const models = await listCodexModels({ command: "/bin/codex", env: {}, includeHidden: true });

    expect(modelListCalls()).toHaveLength(20);
    expect(models).toHaveLength(20);
    expect(fake.state.closed).toBe(1);
  });

  it("closes the App Server when listing fails", async () => {
    fake.state.answer = (method) => {
      if (method === "model/list") throw new Error("model/list timed out");
      return {};
    };

    await expect(
      listCodexModels({ command: "/bin/codex", env: {}, includeHidden: false })
    ).rejects.toThrow("model/list timed out");
    expect(fake.state.closed).toBe(1);
  });
});
