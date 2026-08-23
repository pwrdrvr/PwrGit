// A small unified-diff parser (no library) — handles multi-file patches from
// `git show`/`git diff`, tracks old/new line numbers, and detects add/delete/
// rename/binary. Modeled on PwrAgnt's parseUnifiedDiff.

export type DiffLine =
  | { kind: "add"; newNo: number; text: string }
  | { kind: "del"; oldNo: number; text: string }
  | { kind: "ctx"; oldNo: number; newNo: number; text: string };

export type DiffHunk = { header: string; lines: DiffLine[] };

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed";

export type DiffFile = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  binary: boolean;
};

export type ParsedDiff = {
  files: DiffFile[];
  additions: number;
  deletions: number;
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const stripPrefix = (p: string): string =>
  p.replace(/^[ab]\//, "").replace(/\t.*$/, "");

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const startFile = (path: string): DiffFile => {
    const f: DiffFile = {
      path,
      status: "modified",
      hunks: [],
      additions: 0,
      deletions: 0,
      binary: false
    };
    files.push(f);
    hunk = null;
    return f;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      file = startFile(m?.[2] ?? "");
      continue;
    }
    if (file === null) {
      if (line.startsWith("--- ") || HUNK.test(line)) file = startFile("");
      else continue;
    }
    const f = file;

    if (HUNK.test(line)) {
      const m = HUNK.exec(line) as RegExpExecArray;
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { header: line, lines: [] };
      f.hunks.push(hunk);
      continue;
    }

    // Hunk rows take precedence over file headers. Source content beginning
    // with "-- " is serialized as "--- ", and added content beginning with
    // "++ " as "+++ "; interpreting either as metadata drops the visible row
    // and breaks its typed selection coordinate.
    if (hunk !== null) {
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) {
        hunk.lines.push({ kind: "add", newNo, text: line.slice(1) });
        newNo += 1;
        f.additions += 1;
        continue;
      }
      if (line.startsWith("-")) {
        hunk.lines.push({ kind: "del", oldNo, text: line.slice(1) });
        oldNo += 1;
        f.deletions += 1;
        continue;
      }
      if (line.startsWith(" ")) {
        hunk.lines.push({
          kind: "ctx",
          oldNo,
          newNo,
          text: line.slice(1)
        });
        oldNo += 1;
        newNo += 1;
        continue;
      }
      // Empty split-tail and the next file's metadata are not context rows.
      hunk = null;
      if (line === "") continue;
    }

    if (line.startsWith("new file mode")) {
      f.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      f.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      f.oldPath = line.slice("rename from ".length);
      f.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      f.path = line.slice("rename to ".length);
      f.status = "renamed";
    } else if (
      line.startsWith("Binary files") ||
      line === "GIT binary patch"
    ) {
      f.binary = true;
    } else if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p === "/dev/null") f.status = "added";
      else f.oldPath = stripPrefix(p);
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p === "/dev/null") f.status = "deleted";
      else if (p !== "") f.path = stripPrefix(p);
    }
  }

  return {
    files,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0)
  };
}
