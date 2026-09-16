// The two halves of the release-notes link have to agree, and they live in
// different packages: `releaseNotesUrl` (packages/shared) composes the URL,
// and `isSafeExternalUrl` (this folder's external-links.ts) decides whether
// the process that owns `shell.openExternal` will open it. A shared-package
// test can only re-state that rule; this one runs it, through the same
// `shell:openExternal` verb every surface dispatches.
//
// The composer is deliberately narrow — anchored semver, one path template —
// so the interesting case is not "does a good URL pass" alone but "can the
// composer be made to produce one that shouldn't".
//
// PwrGit's gate differs from PwrSnap's on purpose and the difference matters
// here: PwrSnap allowlists `github.com/pwrdrvr/`, while PwrGit opens PR links
// on whatever forge a remote points at, so this gate admits any credential-free
// http(s) URL. The positive control below is therefore a URL this gate really
// does refuse — otherwise the passing cases would pass just as happily against
// a handler that opened anything.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PWRGIT_LINKS, releaseNotesUrl } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  showItemInFolder: vi.fn(),
  logMain: vi.fn()
}));

vi.mock("electron", () => ({
  dialog: { showMessageBox: vi.fn() },
  shell: {
    openExternal: mocks.openExternal,
    showItemInFolder: mocks.showItemInFolder
  }
}));

vi.mock("./logs", () => ({ logMain: mocks.logMain }));

const { CommandBus } = await import("./command-bus");
const { registerShellHandlers } = await import("./shell-handlers");

const bus = new CommandBus();
registerShellHandlers(bus);

async function open(url: string): Promise<boolean> {
  const result = await bus.dispatch("shell:openExternal", { url });
  return result.ok;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openExternal.mockResolvedValue(undefined);
});

describe("shell:openExternal accepts what releaseNotesUrl composes", () => {
  it.each([
    ["a stable tag", "0.16.1"],
    ["a tag carrying the leading v", "v0.16.0"],
    ["a prerelease tag", "0.16.0-beta.5"],
    ["an alpha tag", "v0.16.0-alpha.11"],
    ["build metadata, which escapes to %2B", "0.16.1+build.3"]
  ])("opens the release page for %s", async (_label, version) => {
    const url = releaseNotesUrl(version);
    expect(url).toBeDefined();
    expect(await open(url as string)).toBe(true);
    expect(mocks.openExternal).toHaveBeenCalledWith(url);
  });

  it("opens the addresses the release pages hang off", async () => {
    // Settings → About's Releases row is the index a version with no tag page
    // of its own falls back to, so it has to pass the same gate.
    for (const url of [PWRGIT_LINKS.source, PWRGIT_LINKS.releases]) {
      expect(await open(url)).toBe(true);
    }
    expect(mocks.openExternal).toHaveBeenCalledTimes(2);
  });

  it("still refuses what the gate exists to refuse", async () => {
    // Positive control. `isSafeExternalUrl` turns away non-web schemes and
    // embedded credentials, and a crafted version cannot reach either — but a
    // gate that never says no would make every assertion above vacuous.
    expect(await open("file:///etc/passwd")).toBe(false);
    expect(await open("javascript:alert(1)")).toBe(false);
    expect(await open("https://user:pass@github.com/pwrdrvr/PwrGit")).toBe(
      false
    );
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("cannot be steered off the releases path by a crafted version", async () => {
    // The composer answers undefined for every one of these, so no surface can
    // put them in front of the gate in the first place.
    for (const version of [
      "0.16.1/../../../../evil",
      "0.16.1?redirect=https://evil.example",
      "https://evil.example/0.16.1",
      "0.16.1@evil.example"
    ]) {
      expect(releaseNotesUrl(version)).toBeUndefined();
    }
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});
