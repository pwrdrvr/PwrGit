import { describe, expect, it } from "vitest";
import { searchNameKey, searchPathLeaf } from "./search-name";

describe("searchNameKey", () => {
  it("ignores case, accents and surrounding whitespace", () => {
    expect(searchNameKey("  Übersicht\t")).toBe(searchNameKey("ubersicht"));
    expect(searchNameKey("CAFÉ")).toBe(searchNameKey(" café "));
    expect(searchNameKey("PwrAgent")).toBe("pwragent");
  });

  it("folds a Greek sigma one way, wherever it falls in the word", () => {
    // Whole-string toLowerCase gives "οδος" with a final ς for "ΟΔΟΣ".
    expect(searchNameKey("ΟΔΟΣ")).toBe(searchNameKey("οδοσ"));
    expect(searchNameKey("οδος")).toBe(searchNameKey("οδοσ"));
    expect(searchNameKey("Σa")).toBe(searchNameKey("ςa"));
  });

  it("meets ß and SS, and drops İ's dot", () => {
    expect(searchNameKey("STRASSE")).toBe(searchNameKey("straße"));
    expect(searchNameKey("İstanbul")).toBe("istanbul");
  });

  it("keeps different names apart", () => {
    expect(searchNameKey("wip_1")).not.toBe(searchNameKey("wip1"));
    expect(searchNameKey("foo bar")).not.toBe(searchNameKey("foobar"));
  });
});

describe("searchPathLeaf", () => {
  it("takes the last segment on either platform", () => {
    expect(searchPathLeaf("/wt/PwrSnap/graph-x")).toBe("graph-x");
    expect(searchPathLeaf("C:\\wt\\graph-x\\")).toBe("graph-x");
    expect(searchPathLeaf("")).toBe("");
  });
});
