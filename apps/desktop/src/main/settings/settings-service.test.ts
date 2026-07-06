import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsService } from "./settings-service";

describe("SettingsService", () => {
  it("returns defaults when no file exists, then persists and reloads atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "pwrgit-settings-"));
    const file = join(dir, "settings.json");

    const s = new SettingsService(file);
    expect(s.get().worktreeRoot).toBeUndefined();

    s.update({ worktreeRoot: "/wt" });
    // A fresh instance reads the persisted value back from disk.
    expect(new SettingsService(file).get().worktreeRoot).toBe("/wt");
  });
});
