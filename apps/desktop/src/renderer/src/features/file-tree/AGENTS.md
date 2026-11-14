# renderer/src/features/file-tree — AGENTS.md

The folder tree every rail file list draws: the Changes tab (one tree per
section), a clicked commit's files (`CommitTab`) and a change request's files
(`ChangeRequestRail`). Design: `design/Changes Tree - UX Review.dc.html`.

- **A new list of repository paths in the rail uses this tree.** Call
  `useFileTree(files, listKey, revealPath)`, draw folder rows with
  `TreeFolderRow`, and give file rows `.tree-file` plus `treeDepthStyle`
  when `nested`. Put `TreeFileDir` before the file's name so the row still
  reads as its full path. Pass `null` while the list loads, never a fresh
  `[]`. A flat list of full paths cuts every deep path to the same
  `…/src/…` prefix, and the Commit tab shipped that way after #598.
- **`listKey` names the list, not the render.** Folds belong to it, so a new
  worktree, commit or scope starts from the defaults.
- **A folder stands for its whole subtree.** Counts and actions use
  `folder.all`, never the folder's direct `files`.
- `file-tree.test.ts` holds the model's properties;
  `file-lists.tree.property.test.tsx` checks each list draws the model.
  Add a new list to its `surfaces`.
