// @vitest-environment jsdom
import fc from "fast-check";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AI_REASONING_EFFORTS, DEFAULT_AI_PROVIDER_SETTINGS, ok, type CodexModelOption } from "@pwrgit/shared";
import type { AiProvidersValue } from "./AiProvidersContext";
const mocks = vi.hoisted(() => ({ context: {} as AiProvidersValue, dispatch: vi.fn(), update: vi.fn(async () => null) }));
vi.mock("./AiProvidersContext", () => ({ useAiProvidersContext: () => mocks.context, useInUseAcpModelProbes: () => [] }));
vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));
import { AiFeaturesSettings } from "./AiFeaturesSettings";
import { __resetCollapsedPanesForTests } from "./SettingsLayout";

const modelId = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/);
const catalog = fc.array(fc.record({ id: modelId, hidden: fc.boolean(),
  supportedReasoningEfforts: fc.subarray([...AI_REASONING_EFFORTS], { minLength: 1 }),
}), { minLength: 1, maxLength: 6 }).map((models): CodexModelOption[] => models.map((model, index) => ({
  ...model, defaultReasoningEffort: model.supportedReasoningEfforts[0]!, model: model.id, displayName: `Codex account ${model.id}`, description: "", isDefault: index === 0,
})));
it("ChatGPT's displayed and saved choices are invariant under another account's generated catalogs", async () => {
  await fc.assert(fc.asyncProperty(modelId, fc.constantFrom(...AI_REASONING_EFFORTS), catalog, catalog,
    async (savedModel, savedEffort, first, second) => {
      __resetCollapsedPanesForTests();
      mocks.update.mockClear();
      mocks.context = {
        profileId: "work", settingsError: null, saving: false, request: () => {}, update: mocks.update,
        settings: { ...DEFAULT_AI_PROVIDER_SETTINGS, jobs: {
          historyEditing: { provider: "chatgpt", model: savedModel, reasoning: savedEffort },
          commitMessage: { provider: "chatgpt" },
        } },
        codexSnapshot: { resolvedPath: "/fixture/codex", candidates: [{ path: "/fixture/codex", source: "path", available: true, version: "1" }], auth: null, refreshedAt: "now" },
        codexSnapshotLoading: false, codexError: null, refreshCodexSnapshot: async () => {},
        acpDiscovery: null, acpDiscoveryLoading: false, acpDiscoveryError: null, refreshAcpDiscovery: async () => {},
        acpModels: {}, acpModelErrors: {}, acpModelsLoadingIds: [], fetchAcpModels: async () => {}, statuses: [],
      };
      let models = first;
      mocks.dispatch.mockImplementation(async () => ok({ models }));
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const render = () => root.render(<AiFeaturesSettings profile={{ profiles: [], value: "work", onChange: () => {} }} />);
      const select = (label: string) => {
        const element = container.querySelector<HTMLSelectElement>(`select[aria-label='${label}']`);
        if (!element) throw new Error(`Missing ${label}`);
        return element;
      };
      try {
        for (const version of ["1", "2"]) {
          if (version === "2") {
            models = second;
            mocks.context = { ...mocks.context, codexSnapshot: { ...mocks.context.codexSnapshot!,
              candidates: [{ path: "/fixture/codex", source: "path", available: true, version }] } };
          }
          await act(async () => { render(); });
          expect(select("History editing model").value).toBe(savedModel);
          expect(select("History editing reasoning effort").value).toBe(savedEffort);
          expect([...select("Commit messages model").options].map((option) => option.text)).toEqual(["Default"]);
          expect(mocks.update).not.toHaveBeenCalled();
        }
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    }));
});
