// Child rows under an expandable Settings nav group, and how the pane scrolls
// when the route moves. Ported from PwrSnap's `settings-nav.ts`, adapted to
// PwrGit's rule that a child is a route to a card in its parent's pane, never
// a pane of its own (settings/AGENTS.md):
//
//   - Forges and AI Providers: one card per product / provider, each child
//     carrying that card's live status (dot + word), so the reader can tell
//     what is installed and working without opening anything.
//   - AI Features: one card per section. A plain jump-to link — sections have
//     no status of their own.
//
// Which pages expand is not decided here: it is exactly the pages that own
// subs in `SETTINGS_PAGE_SUBS` (@pwrgit/shared), the same allowlist main checks
// `settings:open` against.

import {
  SETTINGS_PAGE_SUBS,
  type AiFeaturesSettingsSub,
  type SettingsPage
} from "@pwrgit/shared";
import type { AiProviderStatus, AiProviderTone } from "./ai-provider-status";

export type SettingsNavChild = {
  label: string;
  /** The `SettingsSection` `sectionId` this scrolls the pane to. Also the
   *  React key — one value, so the key and the route id cannot drift apart. */
  sectionId: string;
  /** Status dot tone. Absent while nothing is known, and on a jump link. */
  dot?: AiProviderTone;
  /** Trailing word, so colour is never the only channel. */
  chip?: string;
  /** Accessible name, once there is a state to report. */
  stateLabel?: string;
};

/** Pages whose nav row expands into child rows. */
export const SETTINGS_NAV_GROUPS: ReadonlySet<SettingsPage> = new Set(
  Object.keys(SETTINGS_PAGE_SUBS) as SettingsPage[]
);

/** Card title for each AI Features section. The pane titles its cards from
 *  this too, so a jump link always names the card it lands on. */
export const AI_FEATURE_SECTION_LABELS: Readonly<Record<AiFeaturesSettingsSub, string>> = {
  availability: "Availability",
  "default-agents": "Default agents",
  guidance: "Guidance"
};

/** One provider's nav row, from the same status its card renders. */
export function aiProviderNavChild(status: AiProviderStatus): SettingsNavChild {
  return {
    label: status.label,
    sectionId: status.sub,
    ...(status.tone === undefined ? {} : { dot: status.tone }),
    ...(status.chip === undefined ? {} : { chip: status.chip }),
    ...(status.sentence === undefined ? {} : { stateLabel: status.sentence })
  };
}

/** AI Features' jump links, in the order the pane reads. */
export function aiFeatureNavChildren(): SettingsNavChild[] {
  return SETTINGS_PAGE_SUBS["ai-features"].map((sub) => ({
    label: AI_FEATURE_SECTION_LABELS[sub],
    sectionId: sub
  }));
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
