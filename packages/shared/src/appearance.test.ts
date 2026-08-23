import { describe, expect, it } from "vitest";
import {
  parseAppearanceArg,
  resolveAppearanceTheme,
  serializeAppearanceArg
} from "./appearance";

describe("appearance bootstrap argument", () => {
  it("round-trips the configured and resolved themes", () => {
    const arg = serializeAppearanceArg({
      theme: "system",
      resolvedTheme: "light"
    });
    expect(parseAppearanceArg(["electron", arg])).toEqual({
      theme: "system",
      resolvedTheme: "light"
    });
  });

  it.each([
    { argv: [] },
    { argv: ["--pwrgit-appearance=not-json"] },
    {
      argv: [
        "--pwrgit-appearance={\"theme\":\"sepia\",\"resolvedTheme\":\"dark\"}"
      ]
    },
    {
      argv: [
        "--pwrgit-appearance={\"theme\":\"light\",\"resolvedTheme\":\"system\"}"
      ]
    }
  ])("rejects a missing or invalid token: $argv", ({ argv }) => {
    expect(parseAppearanceArg(argv)).toBeNull();
  });

  it("collapses Electron's native theme query", () => {
    expect(resolveAppearanceTheme(true)).toBe("dark");
    expect(resolveAppearanceTheme(false)).toBe("light");
  });
});
