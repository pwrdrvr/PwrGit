import { describe, expect, it } from "vitest";
import {
  elidePathMiddle,
  hasPrimaryModifier,
  joinDisplayPath,
  pathLeaf,
  pathTail,
  revealPathLabel,
  shortcutLabel
} from "./platform";

describe("platform labels", () => {
  it("keeps compact Command glyphs on macOS", () => {
    expect(shortcutLabel({ key: "F" }, "darwin")).toBe("⌘F");
    expect(shortcutLabel({ key: "R", shift: true }, "darwin")).toBe("⇧⌘R");
    expect(shortcutLabel({ key: "I", alt: true }, "darwin")).toBe("⌥⌘I");
    expect(shortcutLabel({ key: "ArrowDown", shift: true }, "darwin")).toBe(
      "⇧⌘↓"
    );
  });

  it("uses readable Ctrl chords on Windows and Linux", () => {
    expect(shortcutLabel({ key: "F" }, "win32")).toBe("Ctrl+F");
    expect(shortcutLabel({ key: "ArrowUp", shift: true }, "win32")).toBe(
      "Ctrl+Shift+↑"
    );
    expect(shortcutLabel({ key: "P" }, "linux")).toBe("Ctrl+P");
  });

  it("matches the same primary modifier the label advertises", () => {
    const command = { metaKey: true, ctrlKey: false };
    const control = { metaKey: false, ctrlKey: true };
    expect(hasPrimaryModifier(command, "darwin")).toBe(true);
    expect(hasPrimaryModifier(control, "darwin")).toBe(false);
    expect(hasPrimaryModifier(control, "win32")).toBe(true);
    expect(hasPrimaryModifier(command, "win32")).toBe(false);
  });

  it("names the native file manager from the injected platform", () => {
    expect(revealPathLabel("darwin")).toBe("Reveal in Finder");
    expect(revealPathLabel("win32")).toBe("Show in Explorer");
    expect(revealPathLabel("linux")).toBe("Show in folder");
  });
});

describe("cross-platform path labels", () => {
  it("joins child names without treating POSIX backslashes as separators", () => {
    expect(joinDisplayPath("/repos/team\\alpha", "repo", "darwin")).toBe(
      "/repos/team\\alpha/repo"
    );
    expect(joinDisplayPath("/repos/team\\alpha/", "repo", "linux")).toBe(
      "/repos/team\\alpha/repo"
    );
    expect(joinDisplayPath("C:/repos/team/", "repo", "win32")).toBe(
      "C:\\repos\\team\\repo"
    );
  });

  it("reads leaves from POSIX, Windows, mixed, and UNC paths", () => {
    expect(pathLeaf("/Users/me/PwrGit")).toBe("PwrGit");
    expect(pathLeaf("C:\\Users\\me\\PwrGit\\")).toBe("PwrGit");
    expect(pathLeaf("C:/Users/me\\PwrGit")).toBe("PwrGit");
    expect(pathLeaf("\\\\server\\share\\team\\PwrGit")).toBe("PwrGit");
    expect(pathLeaf("")).toBe("");
  });

  it("renders two-segment tails with the target platform separator", () => {
    expect(pathTail("/Users/me/pwrdrvr/PwrGit", 2, "darwin")).toBe(
      "pwrdrvr/PwrGit"
    );
    expect(pathTail("C:/Users/me/pwrdrvr/PwrGit", 2, "win32")).toBe(
      "pwrdrvr\\PwrGit"
    );
    expect(pathTail("C:\\Users\\me\\pwrdrvr\\PwrGit", 2, "win32")).toBe(
      "pwrdrvr\\PwrGit"
    );
    expect(
      pathTail("\\\\fileserver\\engineering\\clients\\PwrGit", 2, "win32")
    ).toBe("clients\\PwrGit");
  });
});

describe("elidePathMiddle", () => {
  it("leaves a path a tooltip can already hold", () => {
    expect(elidePathMiddle("/Users/me/pwrdrvr/PwrGit")).toBe(
      "/Users/me/pwrdrvr/PwrGit"
    );
  });

  it("drops the middle of a worktree path, keeping repo and folder", () => {
    expect(
      elidePathMiddle(
        "/Users/huntharo/claude-worktrees/PwrAgnt/elated-cartwright-f52b78"
      )
    ).toBe("/Users/…/PwrAgnt/elated-cartwright-f52b78");
  });

  it("keeps every trailing segment that still fits", () => {
    expect(
      elidePathMiddle(
        "/Users/huntharo/dev/checkouts/2026/experiments/PwrGit/graph-x"
      )
    ).toBe("/Users/…/2026/experiments/PwrGit/graph-x");
  });

  it("writes the path's own separator, and keeps a UNC prefix", () => {
    expect(
      elidePathMiddle(
        "C:\\Users\\someone\\source\\worktrees\\PwrGit\\dmg-file-art-update-4fd193"
      )
    ).toBe("C:\\…\\worktrees\\PwrGit\\dmg-file-art-update-4fd193");
    expect(
      elidePathMiddle(
        "\\\\fileserver\\engineering\\clients\\acme\\PwrGit\\graph-x"
      )
    ).toBe("\\\\fileserver\\…\\clients\\acme\\PwrGit\\graph-x");
  });

  it("keeps a path with no droppable middle whole, however long", () => {
    const twoSegments = `/${"a".repeat(60)}/graph-x`;
    expect(elidePathMiddle(twoSegments)).toBe(twoSegments);
  });

  it("keeps the real path when an ellipsis would not buy any width", () => {
    // Only "me" sits between the root and the leaf, so the "…" replacing it
    // saves one character and costs a name.
    const path = `/Users/me/${"long-worktree-name-".repeat(3)}x`;
    expect(elidePathMiddle(path)).toBe(path);
  });

  // Runs of separators collapse when the segments are read, so width alone
  // can push a path over the budget while every segment it has still fits —
  // and an "…" there would claim a name had been hidden when none was.
  it("never shows an ellipsis that stands in for nothing", () => {
    const path = `/Users/me${"/".repeat(40)}graph-x`;
    expect(elidePathMiddle(path)).toBe(path);
  });

  it("still elides when even the leaf overflows the budget", () => {
    expect(
      elidePathMiddle(`/Users/me/claude-worktrees/PwrGit/${"x".repeat(60)}`)
    ).toBe(`/Users/…/${"x".repeat(60)}`);
  });
});
