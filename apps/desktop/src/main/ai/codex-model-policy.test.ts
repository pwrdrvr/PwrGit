import { describe, expect, it } from "vitest";
import { DEFAULT_AI_PROVIDER_SETTINGS, type AiProviderSettings, type CodexModelOption } from "@pwrgit/shared";
import { codexDefaultMigration, codexModelChoices } from "./codex-model-policy";

function model(id: string, hidden = false): CodexModelOption {
  return { id, model: id, displayName: id, description: "", hidden, isDefault: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "low" };
}
const legacyIds = ["gpt-5.5", "gpt-5.5-2026-04-23", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"];
function settings(id: string): AiProviderSettings {
  return { ...structuredClone(DEFAULT_AI_PROVIDER_SETTINGS), jobs: { commitMessage: { model: id, reasoning: "high" }, historyEditing: { model: "gpt-6-astra" } } };
}

describe("Codex model choices", () => {
  it.each(["gpt-6-sol", "gpt-6.1-sol"])("hides the older family only when %s is selectable", (sol) => {
    const raw = [...legacyIds.map((id) => model(id)), model(sol), model("gpt-6-astra"), model("gpt-6-luna")];
    const choices = codexModelChoices(raw);
    expect(choices.filter((item) => !item.hidden).map((item) => item.id)).toEqual([sol, "gpt-6-astra", "gpt-6-luna"]);
    expect(raw.every((item) => !item.hidden)).toBe(true);
  });
  it("keeps the old models when newer Sols are absent or hidden", () => {
    const raw = [...legacyIds.map((id) => model(id)), model("gpt-6-luna"), model("gpt-6.1-sol", true)];
    expect(codexModelChoices(raw)).toEqual(raw);
  });
});

describe("Codex default migration", () => {
  it.each(["gpt-5.6-terra", "gpt-5.6", "gpt-6-sol"])("moves %s to GPT-6.1 Sol and preserves Astra", (source) => {
    const current = settings(source);
    expect(codexDefaultMigration(current, [model("gpt-6.1-sol")], current.codex)).toEqual({ jobs: { commitMessage: { model: "gpt-6.1-sol" } } });
  });
  it("moves Luna to Luna independently of Sol availability", () => {
    const current = settings("gpt-5.6-luna");
    expect(codexDefaultMigration(current, [model("gpt-6-luna")], current.codex)).toEqual({ jobs: { commitMessage: { model: "gpt-6-luna" } } });
  });
  it.each(["gpt-5.6-terra", "gpt-5.6", "gpt-6-sol", "gpt-5.6-luna"])("keeps %s without its selectable replacement", (source) => {
    const current = settings(source);
    expect(codexDefaultMigration(current, [model("gpt-6-sol"), model("gpt-6.1-sol", true), model("gpt-6-luna", true)], current.codex)).toBeUndefined();
  });
  it.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.5"])("preserves an explicit %s default", (source) => {
    const current = settings(source);
    expect(codexDefaultMigration(current, [model("gpt-6.1-sol"), model("gpt-6-luna")], current.codex)).toBeUndefined();
  });
  it("keeps an unpinned default unpinned", () => {
    const current = structuredClone(DEFAULT_AI_PROVIDER_SETTINGS);
    expect(codexDefaultMigration(current, [model("gpt-6.1-sol")], current.codex)).toBeUndefined();
  });
  it("clears only an effort the destination explicitly does not support", () => {
    const current = settings("gpt-6-sol");
    current.jobs.commitMessage.reasoning = "none";
    expect(codexDefaultMigration(current, [model("gpt-6.1-sol")], current.codex)).toEqual({ jobs: { commitMessage: { model: "gpt-6.1-sol", reasoning: "" } } });
    const unknownEfforts = { ...model("gpt-6.1-sol"), supportedReasoningEfforts: [] };
    expect(codexDefaultMigration(current, [unknownEfforts], current.codex)).toEqual({ jobs: { commitMessage: { model: "gpt-6.1-sol" } } });
  });
  it("ignores a result from the previous binary or account", () => {
    const current = settings("gpt-6-sol");
    const expected = { ...current.codex };
    current.codex.authProfile = "another-account";
    expect(codexDefaultMigration(current, [model("gpt-6.1-sol")], expected)).toBeUndefined();
    current.codex = { mode: "pinned", pinnedPath: "/opt/other/codex" };
    expect(codexDefaultMigration(current, [model("gpt-6.1-sol")], expected)).toBeUndefined();
  });
});
