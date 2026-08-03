import { describe, expect, it, vi } from "vitest";
import {
  ensureMacKeychainAccess,
  type KeychainMessageBoxOptions
} from "./mac-keychain-access";
import type { AppSettings } from "./settings/settings-service";

function harness(initial: AppSettings = {}) {
  let stored = { ...initial };
  const responses: number[] = [];
  const dialogs: KeychainMessageBoxOptions[] = [];
  const settings = {
    get: () => ({ ...stored }),
    update: (patch: Partial<AppSettings>) => {
      stored = { ...stored, ...patch };
      return { ...stored };
    }
  };
  const showMessageBox = vi.fn(async (options: KeychainMessageBoxOptions) => {
    dialogs.push(options);
    return { response: responses.shift() ?? 0 };
  });
  return { settings, responses, dialogs, showMessageBox, stored: () => stored };
}

describe("ensureMacKeychainAccess", () => {
  it("does nothing outside an installed macOS build", async () => {
    const h = harness();
    const encryptString = vi.fn(() => Buffer.from("encrypted"));

    await expect(
      ensureMacKeychainAccess({
        platform: "darwin",
        packaged: false,
        settings: h.settings,
        showMessageBox: h.showMessageBox,
        encryptString
      })
    ).resolves.toBe(true);

    expect(h.showMessageBox).not.toHaveBeenCalled();
    expect(encryptString).not.toHaveBeenCalled();
  });

  it("explains a first launch before probing Safe Storage", async () => {
    const h = harness();
    const encryptString = vi.fn(() => Buffer.from("encrypted"));

    await expect(
      ensureMacKeychainAccess({
        platform: "darwin",
        packaged: true,
        settings: h.settings,
        showMessageBox: h.showMessageBox,
        encryptString
      })
    ).resolves.toBe(true);

    expect(h.dialogs[0]?.message).toBe(
      "PwrGit is about to ask for Keychain access"
    );
    expect(h.dialogs[0]?.detail).toContain("Always Allow");
    expect(encryptString).toHaveBeenCalledWith(
      "PwrGit macOS keychain access check"
    );
    expect(h.stored()).toEqual({ macKeychainAccessExplained: true });
  });

  it("verifies access on later launches without repeating the explanation", async () => {
    const h = harness({ macKeychainAccessExplained: true });
    const encryptString = vi.fn(() => Buffer.from("encrypted"));

    await expect(
      ensureMacKeychainAccess({
        platform: "darwin",
        packaged: true,
        settings: h.settings,
        showMessageBox: h.showMessageBox,
        encryptString
      })
    ).resolves.toBe(true);

    expect(h.showMessageBox).not.toHaveBeenCalled();
    expect(encryptString).toHaveBeenCalledWith(
      "PwrGit macOS keychain access check"
    );
  });

  it("explains a denial and succeeds when the user tries again", async () => {
    const h = harness();
    h.responses.push(0, 0);
    const encryptString = vi
      .fn<() => Buffer>()
      .mockImplementationOnce(() => {
        throw new Error("User denied Keychain access");
      })
      .mockReturnValueOnce(Buffer.from("encrypted"));
    const onAccessDenied = vi.fn();

    await expect(
      ensureMacKeychainAccess({
        platform: "darwin",
        packaged: true,
        settings: h.settings,
        showMessageBox: h.showMessageBox,
        encryptString,
        onAccessDenied
      })
    ).resolves.toBe(true);

    expect(h.dialogs).toHaveLength(2);
    expect(h.dialogs[1]?.message).toBe(
      "PwrGit could not access its Safe Storage key"
    );
    expect(h.dialogs[1]?.buttons).toEqual(["Try Again", "Quit PwrGit"]);
    expect(onAccessDenied).toHaveBeenCalledOnce();
    expect(h.stored().macKeychainAccessExplained).toBe(true);
  });

  it("leaves the explanation unset when access is denied and the user quits", async () => {
    const h = harness({ macKeychainAccessExplained: true });
    h.responses.push(1);
    const encryptString = vi.fn(() => {
      throw new Error("User denied Keychain access");
    });

    await expect(
      ensureMacKeychainAccess({
        platform: "darwin",
        packaged: true,
        settings: h.settings,
        showMessageBox: h.showMessageBox,
        encryptString
      })
    ).resolves.toBe(false);

    expect(h.stored().macKeychainAccessExplained).toBe(false);
  });

  it("does not touch Keychain when the user quits from the introduction", async () => {
    const h = harness();
    h.responses.push(1);
    const encryptString = vi.fn(() => Buffer.from("encrypted"));

    await expect(
      ensureMacKeychainAccess({
        platform: "darwin",
        packaged: true,
        settings: h.settings,
        showMessageBox: h.showMessageBox,
        encryptString
      })
    ).resolves.toBe(false);

    expect(encryptString).not.toHaveBeenCalled();
    expect(h.stored()).toEqual({});
  });
});
