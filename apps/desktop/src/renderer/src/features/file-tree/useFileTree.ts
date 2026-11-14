import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ancestorDirs,
  buildFileTree,
  folderStartsOpen,
  visibleTreeRows,
  type FileTree,
  type FileTreeFolder,
  type FileTreeRow,
  type TreeFile
} from "./file-tree";

type FoldState = { key: string; open: Readonly<Record<string, boolean>> };

const NONE: Readonly<Record<string, boolean>> = {};
const NO_FILES: readonly never[] = [];

export type FileTreeView<F extends TreeFile> = {
  tree: FileTree<F>;
  /** The rows on screen, folded folders' contents left out. */
  rows: FileTreeRow<F>[];
  /** The list has folders, so its file rows sit in tree columns. A flat list
   *  keeps the plain row layout. */
  nested: boolean;
  toggle: (folder: FileTreeFolder<F>, open: boolean) => void;
};

/**
 * One file list's tree and its fold state.
 *
 * - `files` is `null` while the list loads. Pass the list itself, never a
 *   fresh `[]`: the tree is rebuilt whenever the array's identity changes.
 * - `listKey` names the list (a worktree's staged side, one commit, one change
 *   request's scope). Fold state belongs to it: a new key starts from the
 *   defaults rather than carrying another list's folds.
 * - `revealPath` is the file the main pane shows. When this list holds it, the
 *   folders above its row unfold, once per opening (VS Code's autoReveal):
 *   folding one again afterwards sticks, and a path the list does not hold
 *   writes nothing.
 */
export function useFileTree<F extends TreeFile>(
  loaded: readonly F[] | null,
  listKey: string,
  revealPath: string | null
): FileTreeView<F> {
  const files: readonly F[] = loaded ?? NO_FILES;
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [fold, setFold] = useState<FoldState>({ key: listKey, open: NONE });
  const open = fold.key === listKey ? fold.open : NONE;

  const update = useCallback(
    (change: (open: Readonly<Record<string, boolean>>) => Record<string, boolean>) =>
      setFold((prev) => ({
        key: listKey,
        open: change(prev.key === listKey ? prev.open : NONE)
      })),
    [listKey]
  );

  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (revealPath === null) {
      revealed.current = null;
      return;
    }
    if (!files.some((file) => file.path === revealPath)) return;
    const once = `${listKey}\0${revealPath}`;
    if (revealed.current === once) return;
    revealed.current = once;
    const dirs = ancestorDirs(revealPath);
    if (dirs.length === 0) return;
    update((prev) => {
      const next = { ...prev };
      for (const dir of dirs) next[dir] = true;
      return next;
    });
  }, [files, listKey, revealPath, update]);

  const rows = useMemo(
    () => visibleTreeRows(tree, (folder) => open[folder.dir] ?? folderStartsOpen(folder)),
    [tree, open]
  );
  const toggle = useCallback(
    (folder: FileTreeFolder<F>, isOpen: boolean) =>
      update((prev) => ({ ...prev, [folder.dir]: !isOpen })),
    [update]
  );
  return { tree, rows, nested: tree.folders.length > 0, toggle };
}
