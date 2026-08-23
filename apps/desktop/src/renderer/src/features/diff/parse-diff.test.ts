import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./parse-diff";

describe("parseUnifiedDiff", () => {
  it("parses a modified file with add/del/context and line numbers", () => {
    const patch = [
      "diff --git a/foo.ts b/foo.ts",
      "index 111..222 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;"
    ].join("\n");
    const { files, additions, deletions } = parseUnifiedDiff(patch);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect([f.path, f.status, f.additions, f.deletions]).toEqual([
      "foo.ts",
      "modified",
      1,
      1
    ]);
    expect([additions, deletions]).toEqual([1, 1]);
    const rows = f.hunks[0]!.lines;
    expect(rows.map((r) => r.kind)).toEqual(["ctx", "del", "add", "ctx"]);
    expect(rows[0]).toMatchObject({ kind: "ctx", oldNo: 1, newNo: 1 });
    expect(rows[1]).toMatchObject({ kind: "del", oldNo: 2 });
    expect(rows[2]).toMatchObject({ kind: "add", newNo: 2 });
    expect(rows[3]).toMatchObject({ kind: "ctx", oldNo: 3, newNo: 3 });
  });

  it("detects added / deleted / renamed across a multi-file patch", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,1 @@",
      "+hello",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-bye",
      "diff --git a/from.txt b/to.txt",
      "similarity index 100%",
      "rename from from.txt",
      "rename to to.txt"
    ].join("\n");
    const { files } = parseUnifiedDiff(patch);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["new.txt", "added"],
      ["old.txt", "deleted"],
      ["to.txt", "renamed"]
    ]);
    expect(files[2]?.oldPath).toBe("from.txt");
  });

  it("returns no files for an empty patch", () => {
    expect(parseUnifiedDiff("").files).toEqual([]);
  });

  it("keeps prefix-looking source text as hunk rows", () => {
    const patch = [
      "diff --git a/odd.txt b/odd.txt",
      "--- a/odd.txt",
      "+++ b/odd.txt",
      "@@ -1 +1 @@",
      "--- source text",
      "+++ destination text",
      ""
    ].join("\n");

    const file = parseUnifiedDiff(patch).files[0];
    expect(file?.path).toBe("odd.txt");
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: "del", oldNo: 1, text: "-- source text" },
      { kind: "add", newNo: 1, text: "++ destination text" }
    ]);
  });

  it("detects literal Git binary patches", () => {
    const patch = [
      "diff --git a/art/dot.png b/art/dot.png",
      "index 4fb72b6..9e74fe7 100644",
      "GIT binary patch",
      "literal 12",
      "TcmeAS@N?(olHy`uVBq!ia0vp^",
      ""
    ].join("\n");

    expect(parseUnifiedDiff(patch).files[0]).toMatchObject({
      path: "art/dot.png",
      binary: true
    });
  });
});
