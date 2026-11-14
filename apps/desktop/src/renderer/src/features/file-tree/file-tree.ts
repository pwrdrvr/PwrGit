/**
 * The folder tree every file list in the rail draws: the Changes tab (one per
 * section), a clicked commit's files, and a change request's files. It
 * follows VS Code's Source Control view:
 *
 * - **Nested**: a folder's row stands for everything beneath it, so folding
 *   it hides the whole subtree, and its count (and, in Changes, its Stage and
 *   Discard) covers every file under it.
 * - **Compact**: a folder whose only content is one folder shares that
 *   folder's row (`packages/shared/src`), so a deep path costs one row and one
 *   indent level, not one per segment.
 * - **Folders first**, then files, each in code-unit order (Git's order for
 *   the ASCII paths it lists).
 */
/** Anything with a repository-relative path. `status: "?"` (untracked) is
 *  the only status the tree reads, for the fold default. */
export type TreeFile = { path: string; status?: string };

export type FileTreeFolder<F extends TreeFile> = {
  /** Full path of the deepest folder this row stands for, no trailing slash. */
  dir: string;
  /** What the row shows: one segment, or a compacted chain `a/b/c`. */
  label: string;
  folders: FileTreeFolder<F>[];
  files: F[];
  /** Every file beneath this folder, at any depth, in the input's order. */
  all: F[];
};

export type FileTree<F extends TreeFile> = {
  folders: FileTreeFolder<F>[];
  files: F[];
};

export type FileTreeRow<F extends TreeFile> =
  | { kind: "folder"; folder: FileTreeFolder<F>; depth: number; open: boolean }
  | { kind: "file"; file: F; depth: number };

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

type Draft<F> = {
  dir: string;
  folders: Map<string, Draft<F>>;
  files: F[];
  all: F[];
};

export function buildFileTree<F extends TreeFile>(files: readonly F[]): FileTree<F> {
  const root: Draft<F> = { dir: "", folders: new Map(), files: [], all: [] };
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

  const finish = (draft: Draft<F>, label: string): FileTreeFolder<F> => {
    let node = draft;
    let chain = label;
    // Compact: fold a lone child folder into this row.
    while (node.files.length === 0 && node.folders.size === 1) {
      const only = node.folders.entries().next().value;
      if (only === undefined) break;
      chain = `${chain}/${only[0]}`;
      node = only[1];
    }
    return {
      dir: node.dir,
      label: chain,
      folders: sortedFolders(node),
      files: sortedFiles(node.files),
      all: node.all
    };
  };
  const sortedFolders = (draft: Draft<F>): FileTreeFolder<F>[] =>
    [...draft.folders.entries()]
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([name, child]) => finish(child, name));
  // Labels computed once, not inside the comparator.
  const sortedFiles = (list: F[]): F[] =>
    list
      .map((file) => ({ file, label: fileLabel(file.path) }))
      .sort((a, b) => byCodeUnit(a.label, b.label))
      .map(({ file }) => file);

  return { folders: sortedFolders(root), files: sortedFiles(root.files) };
}

/**
 * Whether a folder nobody has toggled starts open. Only a folder of nothing
 * but new files past the threshold folds: folding on size alone would fold a
 * root like `src/` because a refactor touched forty files in it.
 */
export function folderStartsOpen<F extends TreeFile>(folder: FileTreeFolder<F>): boolean {
  return !(
    folder.all.length > FOLDER_AUTO_COLLAPSE &&
    folder.all.every((file) => file.status === "?")
  );
}

/** The rows on screen: a folded folder hides every row beneath it. */
export function visibleTreeRows<F extends TreeFile>(
  tree: FileTree<F>,
  isOpen: (folder: FileTreeFolder<F>) => boolean
): FileTreeRow<F>[] {
  const rows: FileTreeRow<F>[] = [];
  const walk = (folders: FileTreeFolder<F>[], files: F[], depth: number): void => {
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
