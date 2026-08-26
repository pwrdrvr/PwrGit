import { describe, expect, it } from "vitest";
import {
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
