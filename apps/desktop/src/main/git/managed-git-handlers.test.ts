// Settings › Git › Build track, through the command bus: the track is the
// only setting it writes, and a track it does not know is refused.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ManagedGitTrack } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { AppSettings } from "../settings/settings-service";
import { ManagedGitService } from "./managed/managed-git-service";
import { registerManagedGitHandlers } from "./runtime-status";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pwrgit-managed-handlers-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function setup(stored: Partial<AppSettings> = {}) {
  let settings: Partial<AppSettings> = { ...stored };
  const writes: Array<Partial<AppSettings>> = [];
  const service = new ManagedGitService({
    root: join(scratch, "git-runtimes"),
    platform: "linux",
    arch: "x64",
    bundled: { version: "2.56.0-dev-pwrgit.4", consumerSha256: "0".repeat(64) },
    selection: () => settings.managedGit ?? {},
    track: () => settings.managedGitTrack ?? "latest",
    installedOverride: () => false,
    fetch: async () => {
      throw new Error("no network in this test");
    }
  });
  const bus = new CommandBus();
  registerManagedGitHandlers(bus, service, {
    update: (patch) => {
      writes.push(patch);
      settings = { ...settings, ...patch };
      return settings as AppSettings;
    }
  });
  return { bus, writes, settings: () => settings };
}

describe("gitManaged:setTrack", () => {
  test("follows the chosen track and touches nothing else", async () => {
    const chosen = { managedGit: { selected: "2.56.0-dev-pwrgit.5-97dd200", previous: "2.56.0-dev-pwrgit.4-97dd200" } };
    const { bus, writes, settings } = setup(chosen);
    const result = await bus.dispatch("gitManaged:setTrack", { track: "prerelease" });
    expect(result.ok && result.value.track).toBe("prerelease");
    expect(writes).toEqual([{ managedGitTrack: "prerelease" }]);
    expect(settings().managedGit).toEqual(chosen.managedGit);
  });

  test("refuses a track it does not know, and writes nothing", async () => {
    const { bus, writes } = setup();
    const result = await bus.dispatch("gitManaged:setTrack", { track: "nightly" as ManagedGitTrack });
    expect(result.ok).toBe(false);
    expect(writes).toEqual([]);
  });
});
