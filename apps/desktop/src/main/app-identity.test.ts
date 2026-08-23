import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppIdentity } from "@pwrgit/shared";
import desktopPackage from "../../package.json";

vi.mock("electron", () => ({
  app: {
    getName: vi.fn(),
    getVersion: vi.fn(),
    isPackaged: false
  }
}));

vi.mock("./logs", () => ({ logMain: vi.fn() }));

const {
  createAppIdentity,
  registerAppIdentityHandlers,
  resolvePwrGitVersion
} =
  await import("./app-identity");
const { CommandBus } = await import("./command-bus");

describe("app identity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("formats the installed release, packaged build, and platform facts", () => {
    const identity = createAppIdentity({
      name: "PwrGit",
      version: "1.2.0-alpha.7",
      packaged: true,
      platform: "darwin",
      platformVersion: "15.6.1",
      arch: "arm64",
      electronVersion: "41.0.0"
    });

    expect(identity).toMatchObject({
      name: "PwrGit",
      version: "1.2.0-alpha.7",
      release: { train: "beta", channel: "prerelease" },
      buildType: "packaged",
      platform: { name: "macOS", version: "15.6.1", arch: "arm64" },
      electronVersion: "41.0.0"
    });
    expect(identity.diagnosticsText).toBe(
      [
        "PwrGit 1.2.0-alpha.7",
        "Release: Beta / Prerelease",
        "Build: Packaged",
        "Platform: macOS 15.6.1 (arm64)",
        "Electron: 41.0.0"
      ].join("\n")
    );
  });

  it("reports an unpackaged Windows build without renderer runtime access", () => {
    const identity = createAppIdentity({
      name: "PwrGit",
      version: "0.7.0",
      packaged: false,
      platform: "win32",
      platformVersion: "10.0.26100",
      arch: "x64",
      electronVersion: "41.0.0"
    });

    expect(identity.release).toEqual({ train: "stable", channel: "latest" });
    expect(identity.buildType).toBe("development");
    expect(identity.platform.name).toBe("Windows");
    expect(identity.diagnosticsText).toContain("Build: Development");
  });

  it("uses bundled product metadata when an unpackaged entry reports Electron's version", () => {
    expect(resolvePwrGitVersion(false, "41.10.5")).toBe(
      desktopPackage.version
    );
    expect(resolvePwrGitVersion(false, "41.10.5")).not.toBe("41.10.5");
    expect(resolvePwrGitVersion(true, "1.2.3-alpha.4")).toBe(
      "1.2.3-alpha.4"
    );
  });

  it("registers the copy-ready identity on the typed command bus", async () => {
    const expected = createAppIdentity({
      name: "PwrGit",
      version: "1.0.0",
      packaged: true,
      platform: "linux",
      platformVersion: "6.8.0",
      arch: "x64",
      electronVersion: "41.0.0"
    }) satisfies AppIdentity;
    const bus = new CommandBus();
    registerAppIdentityHandlers(bus, () => expected);

    await expect(bus.dispatch("app:readIdentity", undefined)).resolves.toEqual({
      ok: true,
      value: expected
    });
  });
});
