import { describe, expect, it } from "vitest";
import { SETTINGS_PAGES, settingsPageSubs } from "@pwrgit/shared";
import {
  paneScrollForRoute,
  profilesNavChildren,
  SETTINGS_NAV_GROUPS,
  type PaneRoute
} from "./settings-nav";

describe("SETTINGS_NAV_GROUPS", () => {
  it("expands exactly the pages that own subs", () => {
    // The same table main checks `settings:open` against, so a row can only
    // offer a child a deep link could also reach.
    expect([...SETTINGS_NAV_GROUPS].sort()).toEqual(["forges", "git", "profiles"]);
    for (const page of SETTINGS_PAGES) {
      expect(SETTINGS_NAV_GROUPS.has(page), page).toBe(settingsPageSubs(page).length > 0);
    }
  });
});

describe("paneScrollForRoute", () => {
  const route = (page: PaneRoute["page"], sub: string | null, request: number): PaneRoute => ({
    page,
    sub,
    request
  });

  it("starts a different page at the top", () => {
    expect(paneScrollForRoute(route("general", null, 1), route("forges", null, 2))).toBe(
      "top"
    );
    // Even when a card was asked for: the old page's offset means nothing here.
    expect(paneScrollForRoute(route("general", null, 1), route("forges", "github", 2))).toBe(
      "top"
    );
  });

  it("leaves the scroll alone when a card was asked for on the same page", () => {
    // The card reveals itself from wherever the pane is; jumping to the top
    // first is what made every jump link leap up and scroll back down.
    expect(paneScrollForRoute(route("forges", null, 1), route("forges", "gitlab", 2))).toBe("none");
    expect(paneScrollForRoute(route("forges", "github", 1), route("forges", "gitlab", 2))).toBe(
      "none"
    );
    expect(paneScrollForRoute(route("forges", "github", 1), route("forges", "github", 2))).toBe(
      "none"
    );
  });

  it("travels back to the top when the page's own row follows a card", () => {
    expect(
      paneScrollForRoute(route("forges", "github", 1), route("forges", null, 2))
    ).toBe("travel-top");
  });

  it("travels back to the top on a re-click of the row already shown", () => {
    expect(paneScrollForRoute(route("profiles", null, 1), route("profiles", null, 2))).toBe(
      "travel-top"
    );
  });

  it("does nothing when the route did not move", () => {
    expect(paneScrollForRoute(route("about", null, 3), route("about", null, 3))).toBe("none");
  });
});

describe("profilesNavChildren", () => {
  it("lists every Profiles card, and warns on By folder when its chip does", () => {
    expect(profilesNavChildren(null).map((child) => child.sectionId)).toEqual([
      "git-identity",
      "git-folders",
      "list",
      "hidden"
    ]);
    const byFolder = profilesNavChildren(null, {
      enabled: false,
      globalFile: "/home/rowan/.gitconfig",
      machine: { kind: "missing", message: "x" },
      profiles: [
        {
          profileId: "work",
          name: "Work",
          mono: "W",
          email: "rowan@northwind.example",
          authorName: null,
          roots: ["/home/rowan/Work"],
          overlaps: [],
          includeFile: "/home/rowan/.gitconfig-pwrgit-work",
          repos: [
            {
              repoId: "r",
              name: "api",
              path: "/home/rowan/Work/api",
              email: "rowan@vale.example",
              authorName: null,
              source: "global",
              origin: "/home/rowan/.gitconfig",
              matches: false
            }
          ]
        }
      ]
    })[1];
    expect(byFolder).toMatchObject({ label: "By folder", dot: "warn", stateLabel: "By folder: 1 repo differs" });
  });
});
