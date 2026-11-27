// Child rows under an expandable Settings nav group, and how the pane scrolls
// when the route moves. Ported from PwrSnap's `settings-nav.ts`, adapted to
// PwrGit's rule that a child is a route to a card in its parent's pane, never
// a pane of its own (settings/AGENTS.md).
//
// Which pages expand is not decided here: it is exactly the pages that own
// subs in `SETTINGS_PAGE_SUBS` (@pwrgit/shared), the same allowlist main checks
// `settings:open` against.

import {
  SETTINGS_PAGE_SUBS,
  type FolderIdentityReport,
  type MachineGitIdentity,
  type SettingsPage
} from "@pwrgit/shared";
import { folderCardChip } from "../identity/folder-view";

export type SettingsNavDot = "ok" | "warn" | "bad" | "off" | "accent";

export type SettingsNavChild = {
  label: string;
  /** The `SettingsSection` `sectionId` this scrolls the pane to. Also the
   *  React key — one value, so the key and the route id cannot drift apart. */
  sectionId: string;
  /** Status dot tone. Absent while nothing is known, and on a jump link.
   *  `accent` is news, not trouble: a newer build to download or use. */
  dot?: SettingsNavDot;
  /** Trailing word, so colour is never the only channel. */
  chip?: string;
  /** Accessible name, once there is a state to report. */
  stateLabel?: string;
};

/** Pages whose nav row expands into child rows. */
export const SETTINGS_NAV_GROUPS: ReadonlySet<SettingsPage> = new Set(
  Object.keys(SETTINGS_PAGE_SUBS) as SettingsPage[]
);

/**
 * Profiles' children. "Git identity" carries a warning while Git has no
 * identity of its own, so the condition stays findable after the launch
 * notice was dismissed; nothing at all while unprobed or fine.
 */
export function profilesNavChildren(
  machine: MachineGitIdentity | null,
  folders: FolderIdentityReport | null = null
): SettingsNavChild[] {
  const git: SettingsNavChild = { label: "Git identity", sectionId: "git-identity" };
  if (machine !== null && machine.outside.kind !== "configured") {
    const guessed = machine.outside.kind === "guessed";
    git.dot = "warn";
    git.chip = guessed ? "guessed" : "unset";
    git.stateLabel = guessed
      ? "Git identity: Git is guessing your email"
      : "Git identity: not set outside PwrGit";
  }
  // Warns exactly when the By folder card's chip does, in its words. Like
  // "Git identity", a settled state carries no dot.
  const byFolder: SettingsNavChild = { label: "By folder", sectionId: "git-folders" };
  const chip = folderCardChip(folders);
  if (chip.kind === "warn") {
    byFolder.dot = "warn";
    byFolder.stateLabel = `By folder: ${chip.label}`;
  }
  return [
    git,
    byFolder,
    { label: "Profile list", sectionId: "list" },
    { label: "Hidden repos", sectionId: "hidden" }
  ];
}

export type PaneRoute = {
  page: SettingsPage;
  /** The card asked for, if any. */
  sub: string | null;
  /** Bumps on every navigation, including a re-click of the row already
   *  shown, so a re-click can be told from "nothing happened". */
  request: number;
};

/**
 * What the Settings pane's own scroll does when the route moves from `prev`
 * to `next`:
 *
 * - `"top"`: a different page replaces the content, so it starts at the top.
 *   Without this the new page opened at the old one's scroll offset.
 * - `"none"`: a card was asked for — it scrolls itself into view from wherever
 *   the pane already is (`SettingsSectionStack`'s reveal). Resetting to the top
 *   first is what made every jump link leap up and then scroll back down.
 * - `"travel-top"`: the page's own row, re-clicked (or clicked after a card)
 *   while the reader is further down it, travels back up rather than cutting.
 */
export function paneScrollForRoute(
  prev: PaneRoute,
  next: PaneRoute
): "top" | "none" | "travel-top" {
  if (prev.page !== next.page) return "top";
  if (next.sub !== null) return "none";
  return prev.sub !== null || prev.request !== next.request ? "travel-top" : "none";
}
