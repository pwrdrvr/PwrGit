import { describe, expect, it } from "vitest";
import {
  changeRequestMatch,
  changeRequestNumberQuery
} from "./change-request-query";
import {
  changeRequestHeadRef,
  changeRequestLocalBranch,
  changeRequestPluralLabel
} from "./forge-product";

describe("changeRequestNumberQuery", () => {
  it("reads a bare number with or without either forge's sigil", () => {
    expect(changeRequestNumberQuery("106")).toBe(106);
    expect(changeRequestNumberQuery(" #106 ")).toBe(106);
    expect(changeRequestNumberQuery("!42")).toBe(42);
  });

  it("is not a number query when anything else is typed", () => {
    expect(changeRequestNumberQuery("pr 106")).toBeNull();
    expect(changeRequestNumberQuery("106a")).toBeNull();
    expect(changeRequestNumberQuery("#")).toBeNull();
    expect(changeRequestNumberQuery("0")).toBeNull();
    expect(changeRequestNumberQuery("")).toBeNull();
  });
});

describe("changeRequestMatch", () => {
  const pr = {
    number: 106,
    title: "feat: rebuild the deploy console",
    headRefName: "codex/console-rebuild-plan",
    author: "octo-contrib"
  };

  it("answers a number query with that number only — never its neighbours", () => {
    expect(changeRequestMatch(pr, "106")).toBe("number");
    expect(changeRequestMatch(pr, "#106")).toBe("number");
    expect(changeRequestMatch({ ...pr, number: 1060 }, "106")).toBeNull();
    expect(changeRequestMatch({ ...pr, number: 10 }, "106")).toBeNull();
  });

  it("matches title, head branch, and author as a substring otherwise", () => {
    expect(changeRequestMatch(pr, "Deploy Console")).toBe("text");
    expect(changeRequestMatch(pr, "rebuild-plan")).toBe("text");
    expect(changeRequestMatch(pr, "octo")).toBe("text");
    expect(changeRequestMatch(pr, "tags")).toBeNull();
  });

  it("matches nothing for an empty query", () => {
    expect(changeRequestMatch(pr, "  ")).toBeNull();
  });
});

describe("change-request refs per product", () => {
  it("names the head ref only where the product publishes one", () => {
    expect(changeRequestHeadRef("github", 121)).toBe("refs/pull/121/head");
    expect(changeRequestHeadRef("gitlab", 7)).toBe(
      "refs/merge-requests/7/head"
    );
    expect(changeRequestHeadRef("gitcafe", 3)).toBeNull();
  });

  it("checks a fork's change request out under its number", () => {
    expect(changeRequestLocalBranch("github", 121)).toBe("pr/121");
    expect(changeRequestLocalBranch("gitlab", 7)).toBe("mr/7");
    expect(changeRequestPluralLabel("gitlab")).toBe("Merge requests");
  });
});
