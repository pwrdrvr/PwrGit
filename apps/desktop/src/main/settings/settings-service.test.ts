import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsService } from "./settings-service";

describe("SettingsService", () => {
  it("defaults sharing off and persists seeding only while reflink is on", () => {
    const dir = mkdtempSync(join(tmpdir(), "pwrgit-settings-"));
    const file = join(dir, "settings.json");
    const service = new SettingsService(file);
    expect(service.get()).toMatchObject({ worktreeReflink: "off", worktreeSeedCargoTarget: "off" });
    service.update({ worktreeSeedCargoTarget: "on" });
    expect(service.get().worktreeSeedCargoTarget).toBe("off");
    service.update({ worktreeReflink: "on", worktreeSeedCargoTarget: "on", worktreeShareCommand: "/fixture/pwrgit-share" });
    expect(new SettingsService(file).get()).toMatchObject({ worktreeReflink: "on", worktreeSeedCargoTarget: "on", worktreeShareCommand: "/fixture/pwrgit-share" });
    service.update({ worktreeReflink: "off" });
    service.update({ worktreeReflink: "on" });
    expect(new SettingsService(file).get().worktreeSeedCargoTarget).toBe("off");
    writeFileSync(file, JSON.stringify({ worktreeReflink: "off", worktreeSeedCargoTarget: "on" }));
    expect(new SettingsService(file).get().worktreeSeedCargoTarget).toBe("off");
  });

  it("returns defaults when no file exists, then persists and reloads atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "pwrgit-settings-"));
    const file = join(dir, "settings.json");

    const s = new SettingsService(file);
    expect(s.get().worktreeRoot).toBeUndefined();

    s.update({ worktreeRoot: "/wt" });
    // A fresh instance reads the persisted value back from disk.
    expect(new SettingsService(file).get().worktreeRoot).toBe("/wt");
  });

  it("notifies write listeners after a successful persist", () => {
    const dir = mkdtempSync(join(tmpdir(), "pwrgit-settings-"));
    const file = join(dir, "settings.json");
    const s = new SettingsService(file);
    const writes: string[] = [];
    const off = s.onWrite(() => {
      writes.push(s.get().worktreeRoot ?? "");
    });

    s.update({ worktreeRoot: "/wt" });
    expect(writes).toEqual(["/wt"]);
    off();
    s.update({ worktreeRoot: "/other" });
    expect(writes).toEqual(["/wt"]);
  });
});
