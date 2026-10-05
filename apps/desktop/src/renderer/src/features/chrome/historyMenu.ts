import type {
  NavigationLocation,
  NavigationStacks
} from "../../lib/useNavigationHistory";
import { shortWhen } from "../graph/graph-view";
import type { MenuItem } from "../shell/ContextMenu";

/** Entries per direction. Fifty would be a wall; "back three" is the case. */
export const HISTORY_MENU_DEPTH = 12;

/** The PR section's "refreshed … ago" phrasing, from the same formatter. */
export function agoLabel(at: number, now: number): string {
  const ago = shortWhen(new Date(at).toISOString(), now);
  return ago === "just now" ? ago : `${ago} ago`;
}

function detail(location: NavigationLocation, now: number): string {
  return [
    location.commit === undefined
      ? null
      : `commit ${location.commit.hash.slice(0, 7)}`,
    location.leftAt === undefined ? null : agoLabel(location.leftAt, now)
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * The right-click / press-and-hold list: Forward entries furthest first, the
 * current place, then Back entries nearest first — the order a browser draws,
 * so the list reads top to bottom as the timeline does. Picking one jumps
 * straight there and keeps the rest of the stack.
 */
export function buildHistoryMenu(args: {
  stacks: NavigationStacks;
  label: (location: NavigationLocation) => string;
  goBack: (steps: number) => void;
  goForward: (steps: number) => void;
  now: number;
}): MenuItem[] {
  const { stacks, label, now } = args;
  const entry = (
    location: NavigationLocation,
    onSelect: () => void
  ): MenuItem => {
    const hint = detail(location, now);
    return {
      type: "item",
      label: label(location),
      ...(hint === "" ? {} : { hint }),
      onSelect
    };
  };
  const forward = stacks.forward
    .slice(0, HISTORY_MENU_DEPTH)
    .map((location, index) =>
      entry(location, () => args.goForward(index + 1))
    )
    .reverse();
  const back = stacks.back
    .slice()
    .reverse()
    .slice(0, HISTORY_MENU_DEPTH)
    .map((location, index) => entry(location, () => args.goBack(index + 1)));
  const here: MenuItem[] =
    stacks.cursor === undefined
      ? []
      : [
          {
            type: "item",
            label: label(stacks.cursor),
            hint: "You are here",
            disabled: true,
            onSelect: () => {}
          }
        ];
  return [...forward, ...here, ...back];
}
