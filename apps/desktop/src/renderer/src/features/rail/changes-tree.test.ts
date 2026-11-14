import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { FileChange, FileStatus } from "@pwrgit/shared";
import {
  ancestorDirs,
  buildChangeTree,
  fileLabel,
  folderStartsOpen,
  visibleTreeRows,
  type ChangeTree,
  type ChangeTreeFolder
} from "./changes-tree";

const change = (path: string, status: FileStatus = "M"): FileChange => ({
  path,
  status,
  staged: false
});

function allFolders(tree: ChangeTree): ChangeTreeFolder[] {
  const out: ChangeTreeFolder[] = [];
  const walk = (folders: ChangeTreeFolder[]): void => {
    for (const folder of folders) {
      out.push(folder);
      walk(folder.folders);
    }
  };
  walk(tree.folders);
  return out;
}

/** The parent folder Git would name for a path ("" at the root). */
const parentOf = (path: string): string => {
  const bare = path.endsWith("/") ? path.slice(0, -1) : path;
  const slash = bare.lastIndexOf("/");
  return slash < 0 ? "" : bare.slice(0, slash);
};
const under = (path: string, dir: string): boolean => path.startsWith(`${dir}/`);

describe("buildChangeTree", () => {
  it("nests folders, compacts lone chains, and puts folders first", () => {
    const tree = buildChangeTree([
      change("README.md"),
      change("packages/shared/src/index.ts"),
      change("src/app.ts"),
      change("src/lib/tree.ts"),
      change("design/handoff/assets/menubar.png", "?"),
      change("design/handoff/icon.swift", "?")
    ]);

    expect(
      visibleTreeRows(tree, () => true).map((row) =>
        row.kind === "folder"
          ? `${"  ".repeat(row.depth)}${row.folder.label}/ (${row.folder.all.length})`
          : `${"  ".repeat(row.depth)}${fileLabel(row.file.path)}`
      )
    ).toEqual([
      "design/handoff/ (2)",
      "  assets/ (1)",
      "    menubar.png",
      "  icon.swift",
      "packages/shared/src/ (1)",
      "  index.ts",
      "src/ (2)",
      "  lib/ (1)",
      "    tree.ts",
      "  app.ts",
      "README.md"
    ]);
  });

  it("keeps a nested repository's trailing slash on the leaf", () => {
    const tree = buildChangeTree([change("vendor/", "?"), change("libs/sub/", "?")]);
    expect(tree.files.map((f) => f.path)).toEqual(["vendor/"]);
    expect(tree.folders.map((f) => [f.dir, f.files.map((x) => fileLabel(x.path))])).toEqual([
      ["libs", ["sub/"]]
    ]);
  });

  it("folds only a big folder of nothing but new files", () => {
    const generated = Array.from({ length: 11 }, (_, i) => change(`gen/f${i}.ts`, "?"));
    const edited = Array.from({ length: 11 }, (_, i) => change(`src/f${i}.ts`));
    const mixed = [...generated.map((f) => ({ ...f, path: `lib/${f.path}` })), change("lib/x.ts")];
    const tree = buildChangeTree([...generated, ...edited, ...mixed]);
    const byDir = new Map(allFolders(tree).map((f) => [f.dir, f]));
    expect(folderStartsOpen(byDir.get("gen")!)).toBe(false);
    expect(folderStartsOpen(byDir.get("src")!)).toBe(true);
    // lib/ is not all new, so it stays open; its new-only child folds.
    expect(folderStartsOpen(byDir.get("lib")!)).toBe(true);
    expect(folderStartsOpen(byDir.get("lib/gen")!)).toBe(false);
  });

  it("names every folder above a path", () => {
    expect(ancestorDirs("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorDirs("top.ts")).toEqual([]);
    expect(ancestorDirs("a/vendor/")).toEqual(["a"]);
  });
});

// Short alphabets so paths collide into shared folders often.
const segment = fc.constantFrom("a", "b", "c", "src", "lib", "A", "a.b", "x y");
const pathArb = fc
  .array(segment, { minLength: 1, maxLength: 5 })
  .chain((parts) =>
    // Sometimes a nested repository, which Git lists with a trailing slash.
    fc.boolean().map((nestedRepo) => (nestedRepo ? `${parts.join("/")}/` : parts.join("/")))
  );
// A path and its own folder (`a` the file and `a/b`) cannot both exist, nor
// `a/` the nested repo and `a/b`: Git never lists both.
const changeSetArb = fc
  .uniqueArray(pathArb, { maxLength: 40 })
  .map((paths) => {
    const bare = (p: string): string => (p.endsWith("/") ? p.slice(0, -1) : p);
    const kept: string[] = [];
    for (const path of paths) {
      const clash = kept.some(
        (other) =>
          bare(other) === bare(path) ||
          under(bare(other), bare(path)) ||
          under(bare(path), bare(other))
      );
      if (!clash) kept.push(path);
    }
    return kept;
  })
  .chain((paths) =>
    fc.tuple(
      ...paths.map((path) => fc.constantFrom<FileStatus>("M", "?", "A", "D").map((status) => change(path, status)))
    )
  );

describe("buildChangeTree properties", () => {
  it("lists every file exactly once, under its own parent folder", () => {
    fc.assert(
      fc.property(changeSetArb, (files) => {
        const tree = buildChangeTree(files);
        const rows = visibleTreeRows(tree, () => true);
        const listed = rows.flatMap((row) => (row.kind === "file" ? [row.file.path] : []));
        expect([...listed].sort()).toEqual(files.map((f) => f.path).sort());

        expect(tree.files.every((f) => parentOf(f.path) === "")).toBe(true);
        for (const folder of allFolders(tree)) {
          expect(folder.files.every((f) => parentOf(f.path) === folder.dir)).toBe(true);
          for (const child of folder.folders) expect(under(child.dir, folder.dir)).toBe(true);
        }
      })
    );
  });

  it("a folder stands for exactly the files beneath it (oracle: path prefix)", () => {
    fc.assert(
      fc.property(changeSetArb, (files) => {
        for (const folder of allFolders(buildChangeTree(files))) {
          expect(folder.all.map((f) => f.path)).toEqual(
            files.filter((f) => under(f.path, folder.dir)).map((f) => f.path)
          );
        }
      })
    );
  });

  it("compacts: no folder row holds a lone folder and nothing else", () => {
    fc.assert(
      fc.property(changeSetArb, (files) => {
        const check = (folders: ChangeTreeFolder[], parent: string): void => {
          for (const folder of folders) {
            expect(folder.files.length === 0 && folder.folders.length === 1).toBe(false);
            // The label is exactly the path between its parent row and itself.
            expect(folder.dir).toBe(parent === "" ? folder.label : `${parent}/${folder.label}`);
            check(folder.folders, folder.dir);
          }
        };
        check(buildChangeTree(files).folders, "");
      })
    );
  });

  it("a folded folder hides everything beneath it, and nothing else", () => {
    fc.assert(
      fc.property(
        changeSetArb.chain((files) => {
          const dirs = allFolders(buildChangeTree(files)).map((f) => f.dir);
          return fc.tuple(fc.constant(files), fc.subarray(dirs));
        }),
        ([files, folded]) => {
          const closed = new Set(folded);
          const rows = visibleTreeRows(buildChangeTree(files), (f) => !closed.has(f.dir));
          const shownFiles = rows.flatMap((r) => (r.kind === "file" ? [r.file.path] : []));
          const shownFolders = rows.flatMap((r) => (r.kind === "folder" ? [r.folder.dir] : []));
          // Oracle: visible iff no folded folder is a proper ancestor.
          const hidden = (path: string): boolean => folded.some((dir) => under(path, dir));
          expect([...shownFiles].sort()).toEqual(
            files.map((f) => f.path).filter((p) => !hidden(p)).sort()
          );
          expect(shownFolders.every((dir) => !hidden(dir))).toBe(true);
        }
      )
    );
  });
});
