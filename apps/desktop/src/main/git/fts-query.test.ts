import { describe, expect, it } from "vitest";
import { buildFtsQuery } from "./fts-query";

describe("buildFtsQuery", () => {
  it("splits on punctuation like the unicode61 tokenizer", () => {
    expect(buildFtsQuery("claude/side-by-side")).toBe(
      '"claude"* "side"* "by"* "side"*'
    );
  });

  it("quotes tokens so FTS5 operators are literal text", () => {
    expect(buildFtsQuery("NOT AND OR")).toBe('"NOT"* "AND"* "OR"*');
  });

  it("prefix-stars every token for as-you-type matching", () => {
    expect(buildFtsQuery("exp 8013")).toBe('"exp"* "8013"*');
  });

  it("returns null for empty or punctuation-only input", () => {
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("   ")).toBeNull();
    expect(buildFtsQuery("/-·…")).toBeNull();
  });
});
