import { describe, expect, it } from "vitest";
import { buildRenderedLogLines, tokenizeLogLine } from "./LogsWindow";

const LINE =
  "[2026-07-27 14:19:24.333] [error] (command) remote:pull failed: boom";

describe("tokenizeLogLine", () => {
  it("splits a formatted line into toned parts and extracts the level", () => {
    const result = tokenizeLogLine(LINE);
    expect(result.level).toBe("error");
    expect(result.parts.map((p) => p.tone)).toEqual([
      "timestamp",
      undefined,
      "level-error",
      undefined,
      "scope",
      undefined,
      undefined
    ]);
    expect(result.parts[0].text).toBe("[2026-07-27 14:19:24.333]");
    expect(result.parts[4].text).toBe("(command)");
    expect(result.parts[6].text).toBe("remote:pull failed: boom");
  });

  it("passes unstructured lines through untouched", () => {
    const result = tokenizeLogLine("plain stderr noise");
    expect(result.level).toBeUndefined();
    expect(result.parts).toEqual([{ text: "plain stderr noise" }]);
  });
});

describe("buildRenderedLogLines", () => {
  it("numbers lines and counts case-insensitive matches across tokens", () => {
    const content = [LINE, "[2026-07-27 14:20:00.000] [info ] (app) PULL ok"].join(
      "\n"
    );
    const { lines, matchCount } = buildRenderedLogLines(content, "pull");
    expect(lines).toHaveLength(2);
    expect(lines[0].lineNumber).toBe(1);
    expect(lines[1].level).toBe("info");
    expect(matchCount).toBe(2);
    const matched = lines
      .flatMap((line) => line.parts)
      .filter((part) => part.matchIndex !== undefined);
    expect(matched.map((part) => part.matchIndex)).toEqual([0, 1]);
    expect(matched.map((part) => part.text)).toEqual(["pull", "PULL"]);
  });

  it("returns no lines for empty content and no matches for empty query", () => {
    expect(buildRenderedLogLines("", "x").lines).toHaveLength(0);
    expect(buildRenderedLogLines(LINE, "").matchCount).toBe(0);
  });
});
