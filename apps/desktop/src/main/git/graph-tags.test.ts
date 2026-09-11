import { describe, expect, it } from "vitest";
import { ok } from "@pwrgit/shared";
import { readGraphTags } from "./graph-tags";

describe("prominent graph tags", () => {
  it("prefers stable versions, then annotations, then prereleases; omits build noise and non-commits", async () => {
    const rows = [
      ["v2.10.0", "commit", "a", "", ""],
      ["v2.9.0", "commit", "a", "", ""],
      ["release-note", "tag", "object", "commit", "a"],
      ["v3.0.0-beta", "commit", "a", "", ""],
      ["v3.0.0-beta", "commit", "b", "", ""],
      ["milestone", "tag", "object", "commit", "b"],
      ["v1.0.0-beta", "commit", "c", "", ""],
      ["build/123", "commit", "d", "", ""],
      ["v5.0.0", "tag", "object", "tree", "e"]
    ];
    const result = await readGraphTags(async () => ok({ stdout: rows.map((r) => r.join("\0")).join("\n"), stderr: "", exitCode: 0 }), "/repo");
    expect(result).toEqual(ok({
      a: { name: "v2.10.0", kind: "lightweight" },
      b: { name: "milestone", kind: "annotated" },
      c: { name: "v1.0.0-beta", kind: "lightweight" }
    }));
  });
});
