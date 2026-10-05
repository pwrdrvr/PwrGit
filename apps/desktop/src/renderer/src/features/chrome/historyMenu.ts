import type {
  NavigationLocation,
  NavigationStacks
} from "../../lib/useNavigationHistory";
import type { MenuItem } from "../shell/ContextMenu";

/** Entries per direction. Fifty would be a wall; "back three" is the case. */
export const HISTORY_MENU_DEPTH = 12;

export function agoLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function detail(location: NavigationLocation, now: number): string {
  return [
    location.commit === undefined
      ? null
      : `commit ${location.commit.hash.slice(0, 7)}`,
    location.leftAt === undefined ? null : agoLabel(now - location.leftAt)
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
