import { describe, expect, it } from "vitest";
import { linuxWindowIconPath } from "./window-icon";

const env = {
  platform: "linux" as NodeJS.Platform,
  packaged: false,
  appPath: "/home/dev/PwrGit/apps/desktop",
  resourcesPath: "/opt/PwrGit/resources"
};

describe("linux window icon", () => {
  it("reads the repository master in a dev run", () => {
    expect(linuxWindowIconPath(env)).toBe(
      "/home/dev/PwrGit/apps/desktop/build/icon.png"
    );
  });

  it("reads the staged resource in a packaged run", () => {
    expect(linuxWindowIconPath({ ...env, packaged: true })).toBe(
      "/opt/PwrGit/resources/icon.png"
    );
  });

  it.each(["darwin", "win32"] as const)(
    "leaves %s to the bundle icon",
    (platform) => {
      expect(linuxWindowIconPath({ ...env, platform })).toBeNull();
    }
  );
});
