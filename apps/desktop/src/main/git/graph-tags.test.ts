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
    let argv: string[] = [];
    const result = await readGraphTags(async (args) => {
      argv = args;
      return ok({ stdout: rows.map((r) => r.join("\0")).join("\n"), stderr: "", exitCode: 0 });
    }, "/repo");
    // The tie-break above is first-seen-wins, which is only the *version* order
    // because git is asked for it. Drop the sort and `a` chips as v2.9.0 while
    // the rest of this test still passes, so pin the flag here.
    expect(argv).toContain("--sort=-version:refname");
    expect(result).toEqual(ok({
      a: { name: "v2.10.0", kind: "lightweight" },
      b: { name: "milestone", kind: "annotated" },
      c: { name: "v1.0.0-beta", kind: "lightweight" }
    }));
  });

  it("reports a failed scan rather than pretending the repo has no tags", async () => {
    // graph:lanes downgrades this to "no chips" on purpose; readGraphTags
    // itself must still say it failed, or that choice cannot be made by the
    // caller — and a future caller would silently cache an empty map.
    const result = await readGraphTags(
      async () => ok({ stdout: "", stderr: "fatal: not a git repository", exitCode: 128 }),
      "/repo"
    );
    expect(result.ok).toBe(false);
  });

  it("returns an empty map for a repo with no tags at all", async () => {
    const result = await readGraphTags(async () => ok({ stdout: "", stderr: "", exitCode: 0 }), "/repo");
    expect(result).toEqual(ok({}));
  });
});
