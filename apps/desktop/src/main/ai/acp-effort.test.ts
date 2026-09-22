import { describe, expect, it } from "vitest";
import { acpReasoningEffort } from "./acp-effort";

describe("acpReasoningEffort", () => {
  it("keeps low as Fast, the one effort that turns an ACP agent's thinking off", () => {
    expect(acpReasoningEffort("low")).toBe("low");
  });

  it("reads the efforts below low as Fast too", () => {
    // They ask for less thinking than low does; reading them as Thinking
    // turned the lightest Codex choice into the heaviest ACP one.
    expect(acpReasoningEffort("minimal")).toBe("low");
    expect(acpReasoningEffort("none")).toBe("low");
  });

  it("collapses medium to Thinking instead of handing the kit a value it drops", () => {
    // The kit maps only low/high onto `thought_level`; a "medium" left over
    // from a Codex choice would silently become the agent's own default.
    expect(acpReasoningEffort("medium")).toBe("high");
  });

  it("reads every other Codex effort as Thinking", () => {
    for (const effort of ["high", "xhigh", "some-future-effort"]) {
      expect(acpReasoningEffort(effort)).toBe("high");
    }
  });
});
