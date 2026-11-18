import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { MenuItem } from "../shell/ContextMenu";
import { repoMenuItems } from "./repo-menu-items";

const noop = (): void => undefined;
const ACTIONS = {
  onTogglePin: noop,
  onMove: noop,
  onFork: noop,
  onManageRemotes: noop,
  onOpenSetup: noop,
  onRefreshForgeInfo: noop,
  onHide: noop,
  onRemove: noop
};

type Entry = Extract<MenuItem, { type: "item" }>;
const entries = (items: MenuItem[]): Entry[] =>
  items.filter((item): item is Entry => item.type === "item");

const input = fc.record({
  pinned: fc.boolean(),
  arrangeable: fc.boolean(),
  up: fc.boolean(),
  down: fc.boolean(),
  platform: fc.constantFrom("darwin", "win32", "linux"),
  name: fc.string({ minLength: 1, maxLength: 12 })
});

type Input = {
  pinned: boolean;
  arrangeable: boolean;
  up: boolean;
  down: boolean;
  platform: string;
  name: string;
};

const build = (i: Input) =>
  repoMenuItems({
    repo: { name: i.name, path: `/code/${i.name}`, pinned: i.pinned },
    platform: i.platform,
    arrangeable: i.arrangeable,
    moveRoom: { up: i.up, down: i.down },
    removeHint: "hint",
    actions: ACTIONS
  });

// Repo Index Context Menu, 2a and 2b: PwrAgnt's order, one list for the tree
// row and the index name alike.
describe("repoMenuItems", () => {
  it("leads with the pin, says the pin's state, and moves only a pin", () => {
    fc.assert(
      fc.property(input, (i) => {
        const items = entries(build(i));
        expect(items[0]?.label).toBe(i.pinned ? "Unpin repository" : "Pin repository");
        const moves = items.filter((item) => item.label.startsWith("Move "));
        if (!i.arrangeable) {
          expect(moves).toEqual([]);
          return;
        }
        expect(moves.map((m) => m.label)).toEqual(["Move up", "Move down"]);
        expect(items.slice(1, 3)).toEqual(moves);
        // Disabled exactly where there is no neighbour to swap with.
        expect(moves[0]?.disabled).toBe(!i.up);
        expect(moves[1]?.disabled).toBe(!i.down);
        // The hint is the platform's chord, and is announced as one.
        const mac = i.platform === "darwin";
        expect(moves[0]?.shortcut).toBe(mac ? "⇧⌘↑" : "Ctrl+Shift+↑");
        expect(moves[1]?.keyshortcuts).toBe(
          `${mac ? "Meta" : "Control"}+Shift+ArrowDown`
        );
      })
    );
  });

  it("keeps every other entry, in one order, and ends with leaving the list", () => {
    fc.assert(
      fc.property(input, (i) => {
        const items = build(i);
        const rest = entries(items)
          .map((item) => item.label)
          .filter((label) => !/^(Un)?[Pp]in repository$|^Move /.test(label));
        expect(rest.slice(2)).toEqual([
          `Fork ${i.name}…`,
          "Manage remotes…",
          "Repository setup…",
          "Refresh forge info",
          "Hide repository",
          "Remove repository…"
        ]);
        expect(rest[1]).toBe("Copy path");
        // Separators only between groups: never first, last or doubled.
        expect(items[0]?.type).toBe("item");
        expect(items.at(-1)?.type).toBe("item");
        items.forEach((item, at) => {
          if (item.type === "sep") expect(items[at + 1]?.type).not.toBe("sep");
        });
      })
    );
  });
});
