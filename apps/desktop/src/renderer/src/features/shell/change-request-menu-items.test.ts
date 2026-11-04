import { describe, expect, it } from "vitest";
import { changeRequestMenuItems } from "./change-request-menu-items";

const labels = (items: ReturnType<typeof changeRequestMenuItems>): string[] =>
  items.map((item) => (item.type === "item" ? item.label : "—"));

describe("changeRequestMenuItems", () => {
  it("says pull request on GitHub", () => {
    expect(
      labels(changeRequestMenuItems({ number: 12, url: "https://x/12", forge: "github" }))
    ).toEqual(["Open pull request #12", "Copy pull request #12 link"]);
  });

  it("says merge request, with GitLab's sigil, on GitLab", () => {
    expect(
      labels(changeRequestMenuItems({ number: 12, url: "https://x/12", forge: "gitlab" }))
    ).toEqual(["Open merge request !12", "Copy merge request !12 link"]);
  });
});
