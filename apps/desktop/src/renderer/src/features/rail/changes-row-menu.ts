import type { FileChange } from "@pwrgit/shared";
import type { MenuItem } from "../shell/ContextMenu";

/** What a right-click landed on: one file, or a folder group's whole contents. */
export type ChangesRowTarget =
  | { kind: "file"; file: FileChange }
  | { kind: "folder"; dir: string; files: FileChange[] };

export type ChangesRowActions = {
  onToggle: () => void;
  onDiscard: () => void;
  onIgnore: () => void;
  onCopyPath: () => void;
};

/** Paths the row stands for — one file, or every file the folder lists. */
export function targetPaths(target: ChangesRowTarget): string[] {
  return target.kind === "file"
    ? [target.file.path]
    : target.files.map((file) => file.path);
}

/**
 * `.gitignore` only has an effect on files git is not already tracking, so the
 * action is offered only when *everything* the row stands for is untracked.
 * Offering it on a tracked file would write a line that changes nothing and
 * leave the user believing the file is now ignored.
 */
export function canIgnore(target: ChangesRowTarget): boolean {
  return target.kind === "file"
    ? target.file.status === "?"
    : target.files.length > 0 &&
        target.files.every((file) => file.status === "?");
}

/** The `.gitignore` pattern a row implies — a folder ignores the folder. */
export function ignorePathFor(target: ChangesRowTarget): {
  path: string;
  directory: boolean;
} {
  return target.kind === "file"
    ? { path: target.file.path, directory: false }
    : { path: target.dir, directory: true };
}

/**
 * Whether the row's verb is "unstage". A folder counts as staged only when
 * every file in it is — a partly-staged folder still has staging left to do,
 * so that is the action to offer.
 */
export function targetIsStaged(target: ChangesRowTarget): boolean {
  return target.kind === "file"
    ? target.file.staged
    : target.files.length > 0 && target.files.every((file) => file.staged);
}

function fileLabel(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}

export function changesRowMenuItems(
  target: ChangesRowTarget,
  actions: ChangesRowActions
): MenuItem[] {
  const staged = targetIsStaged(target);
  const count = targetPaths(target).length;
  const scope = target.kind === "file" ? "" : ` (${fileLabel(count)})`;

  const items: MenuItem[] = [
    {
      type: "item",
      label: `${staged ? "Unstage" : "Stage"}${scope}`,
      onSelect: actions.onToggle
    }
  ];

  if (canIgnore(target)) {
    items.push({
      type: "item",
      label:
        target.kind === "file"
          ? "Add to .gitignore"
          : "Add folder to .gitignore",
      onSelect: actions.onIgnore
    });
  }

  items.push(
    { type: "item", label: "Copy path", onSelect: actions.onCopyPath },
    { type: "sep" },
    {
      type: "item",
      label: `Discard${scope === "" ? " changes" : scope}…`,
      danger: true,
      onSelect: actions.onDiscard
    }
  );

  return items;
}
