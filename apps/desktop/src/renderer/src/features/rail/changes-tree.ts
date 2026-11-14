import type { FileChange } from "@pwrgit/shared";

/**
 * The Changes rail's folder tree. Each section (staged, unstaged) builds its
 * own, the way VS Code's Source Control view does:
 *
 * - **Nested**: a folder's row stands for everything beneath it, so folding
 *   it hides the whole subtree and its count, Stage and Discard cover every
 *   file under it. The earlier grouping keyed on each file's immediate parent
 *   only, which made `foo/` and `foo/bar/` unrelated siblings.
 * - **Compact**: a folder whose only content is one folder shares that
 *   folder's row (`packages/shared/src`), so a deep path costs one row and one
 *   indent level, not one per segment.
 * - **Folders first**, then files, each in code-unit order (Git's order for
 *   the ASCII paths it lists).
 */
export type ChangeTreeFolder = {
  /** Full path of the deepest folder this row stands for, no trailing slash. */
  dir: string;
  /** What the row shows: one segment, or a compacted chain `a/b/c`. */
  label: string;
  folders: ChangeTreeFolder[];
  files: FileChange[];
  /** Every file beneath this folder, at any depth, in the input's order. */
  all: FileChange[];
};

export type ChangeTree = {
  folders: ChangeTreeFolder[];
  files: FileChange[];
};

export type ChangeTreeRow =
  | { kind: "folder"; folder: ChangeTreeFolder; depth: number; open: boolean }
  | { kind: "file"; file: FileChange; depth: number };

/** A folder of only new files this big starts folded: an untracked dump can
 *  be hundreds of files, and unfolding all of them buries the rest. */
export const FOLDER_AUTO_COLLAPSE = 10;

/**
 * Path segments of a file. Git lists an untracked nested repository as
 * `vendor/` — a leaf with a trailing slash, not a folder to descend into — so
 * the slash stays on the last segment.
 */
function segments(path: string): string[] {
  const bare = path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = bare.split("/");
  if (bare !== path) parts[parts.length - 1] = `${parts[parts.length - 1] ?? ""}/`;
  return parts;
}

/** The text a file row shows: its last segment. */
export function fileLabel(path: string): string {
  const parts = segments(path);
  return parts[parts.length - 1] ?? path;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Draft = {
  dir: string;
  folders: Map<string, Draft>;
  files: FileChange[];
  all: FileChange[];
};

export function buildChangeTree(files: FileChange[]): ChangeTree {
  const root: Draft = { dir: "", folders: new Map(), files: [], all: [] };
  for (const file of files) {
    const parts = segments(file.path);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i] ?? "";
      let next = node.folders.get(name);
      if (next === undefined) {
        next = {
          dir: node.dir === "" ? name : `${node.dir}/${name}`,
          folders: new Map(),
          files: [],
          all: []
        };
        node.folders.set(name, next);
      }
      next.all.push(file);
      node = next;
    }
    node.files.push(file);
  }

  const finish = (draft: Draft, label: string): ChangeTreeFolder => {
    let node = draft;
    let chain = label;
    // Compact: fold a lone child folder into this row.
    for (;;) {
      if (node.files.length > 0 || node.folders.size !== 1) break;
      const [name, only] = [...node.folders.entries()][0] ?? [];
      if (name === undefined || only === undefined) break;
      chain = `${chain}/${name}`;
      node = only;
    }
    return {
      dir: node.dir,
      label: chain,
      folders: sortedFolders(node),
      files: sortedFiles(node.files),
      all: node.all
    };
  };
  const sortedFolders = (draft: Draft): ChangeTreeFolder[] =>
    [...draft.folders.entries()]
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([name, child]) => finish(child, name));
  const sortedFiles = (list: FileChange[]): FileChange[] =>
    [...list].sort((a, b) => byCodeUnit(fileLabel(a.path), fileLabel(b.path)));

  return { folders: sortedFolders(root), files: sortedFiles(root.files) };
}

/**
 * Whether a folder nobody has toggled starts open. Only a folder of nothing
 * but new files past the threshold folds: folding on size alone would fold a
 * root like `src/` because a refactor touched forty files in it.
 */
export function folderStartsOpen(folder: ChangeTreeFolder): boolean {
  return !(
    folder.all.length > FOLDER_AUTO_COLLAPSE &&
    folder.all.every((file) => file.status === "?")
  );
}

/** The rows on screen: a folded folder hides every row beneath it. */
export function visibleTreeRows(
  tree: ChangeTree,
  isOpen: (folder: ChangeTreeFolder) => boolean
): ChangeTreeRow[] {
  const rows: ChangeTreeRow[] = [];
  const walk = (folders: ChangeTreeFolder[], files: FileChange[], depth: number): void => {
    for (const folder of folders) {
      const open = isOpen(folder);
      rows.push({ kind: "folder", folder, depth, open });
      if (open) walk(folder.folders, folder.files, depth + 1);
    }
    for (const file of files) rows.push({ kind: "file", file, depth });
  };
  walk(tree.folders, tree.files, 0);
  return rows;
}

/** Every folder above a path, shallowest first: `a/b/c.ts` → `a`, `a/b`. */
export function ancestorDirs(path: string): string[] {
  const parts = segments(path);
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join("/"));
  return dirs;
}
