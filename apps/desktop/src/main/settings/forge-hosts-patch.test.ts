import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORGE_HOST_LABEL_MAX,
  ok,
  type AppSettingsPatch
} from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { SettingsService } from "./settings-service";
import { registerSettingsHandlers } from "./settings-handlers";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-forge-hosts-"));
  const settings = new SettingsService(join(dir, "settings.json"));
  const bus = new CommandBus();
  registerSettingsHandlers(bus, settings, {
    diagnosticsOutputRoot: dir,
    appVersion: "1.0.0",
    onChanged: () => undefined
  });
  const update = async (patch: AppSettingsPatch) =>
    await bus.dispatch("settings:update", { patch });
  return { settings, update };
}

describe("forgeHosts patch path", () => {
  it("keeps a stored kind when only `enabled` is written", async () => {
    // The pane sends one field at a time. A wholesale write erased `kind`,
    // which is what makes a hand-added host resolve — the row then vanished
    // with no way to bring it back.
    const { settings, update } = harness();
    await update({ forgeHosts: { "git.contoso.dev": { kind: "gitlab" } } });
    await update({ forgeHosts: { "git.contoso.dev": { enabled: false } } });
    expect(settings.get().forges?.hosts["git.contoso.dev"]).toEqual({
      kind: "gitlab",
      enabled: false
    });
  });

  it("stores a short name for a host, and clears it on an empty one", async () => {
    // Merging cannot express a removal, so `label: ""` is the instruction to
    // drop the name — without it a cleared field silently kept the old one.
    const { settings, update } = harness();
    await update({ forgeHosts: { "ghe.acme.example": { kind: "github" } } });
    await update({ forgeHosts: { "ghe.acme.example": { label: "  Acme  " } } });
    expect(settings.get().forges?.hosts["ghe.acme.example"]).toEqual({
      kind: "github",
      label: "Acme"
    });
    await update({ forgeHosts: { "ghe.acme.example": { label: "" } } });
    expect(settings.get().forges?.hosts["ghe.acme.example"]).toEqual({
      kind: "github"
    });
  });

  it("caps a pasted short name rather than storing an essay", async () => {
    const { settings, update } = harness();
    await update({ forgeHosts: { "a.example": { label: "z".repeat(400) } } });
    expect(
      settings.get().forges?.hosts["a.example"]?.label
    ).toHaveLength(FORGE_HOST_LABEL_MAX);
  });

  it("drops a host left with nothing decided about it", async () => {
    // A name is the only thing on this host, and clearing it leaves no
    // decision at all — the same state as never having had a row, which is
    // what returns the host to `auto`.
    const { settings, update } = harness();
    await update({ forgeHosts: { "a.example": { label: "Acme" } } });
    await update({ forgeHosts: { "a.example": { label: "" } } });
    expect(settings.get().forges?.hosts["a.example"]).toBeUndefined();
  });

  it("ignores a label that is not a string", async () => {
    // settings.json is parsed unvalidated and this crosses IPC.
    const { settings, update } = harness();
    await update({
      forgeHosts: {
        "a.example": { kind: "github", label: 7 as unknown as string }
      }
    });
    expect(settings.get().forges?.hosts["a.example"]).toEqual({
      kind: "github"
    });
  });

  it("merges host by host rather than replacing the map", async () => {
    const { settings, update } = harness();
    await update({ forgeHosts: { "a.example": { kind: "github" } } });
    await update({ forgeHosts: { "b.example": { kind: "gitlab" } } });
    expect(Object.keys(settings.get().forges?.hosts ?? {}).sort()).toEqual([
      "a.example",
      "b.example"
    ]);
  });

  it("clears an entry on null", async () => {
    const { settings, update } = harness();
    await update({ forgeHosts: { "a.example": { kind: "github" } } });
    await update({ forgeHosts: { "a.example": null } });
    expect(settings.get().forges?.hosts["a.example"]).toBeUndefined();
  });

  it("canonicalizes the key the same way host resolution does", async () => {
    // Stored under a spelling no lookup matches = a setting that silently
    // does nothing.
    const { settings, update } = harness();
    await update({ forgeHosts: { "WWW.Git.Contoso.Dev": { kind: "github" } } });
    expect(settings.get().forges?.hosts["git.contoso.dev"]).toEqual({
      kind: "github"
    });
  });

  it("refuses a key that is not a bare hostname", async () => {
    const { settings, update } = harness();
    await update({ forgeHosts: { "ghe.example:8443": { kind: "github" } } });
    await update({ forgeHosts: { "has space": { kind: "github" } } });
    expect(settings.get().forges?.hosts ?? {}).toEqual({});
  });

  it("reports the stored hosts back on the snapshot", async () => {
    const { update } = harness();
    const result = await update({
      forgeHosts: { "a.example": { kind: "github", enabled: false } }
    });
    expect(result).toEqual(
      ok(
        expect.objectContaining({
          forges: { hosts: { "a.example": { kind: "github", enabled: false } } }
        })
      )
    );
  });
});
