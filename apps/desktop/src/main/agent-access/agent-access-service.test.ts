import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { McpPolicyStore } from "@pwrgit/mcp-server/access-policy";
import { SettingsService } from "../settings/settings-service";
import { AgentAccessService } from "./agent-access-service";

it("persists enablement and starts/stops the listener", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-access-service-"));
  const settingsFile = join(dir, "settings.json");
  const settings = new SettingsService(settingsFile);
  const policyFile = join(dir, "policy.json");
  new McpPolicyStore(policyFile).initialize();
  const service = new AgentAccessService({
    policyFile, clientsFile: join(dir, "clients.json"), port: 0,
    saveEnabled: enabled => { settings.update({ localAgentAccessEnabled: enabled }); },
    onChanged: () => undefined,
    requestConsent: async () => ({ decision: "deny", sessionName: "", roleId: "" })
  });
  try {
    expect(service.status()).toMatchObject({ enabled: false, listening: false });
    expect(await service.setEnabled(true)).toMatchObject({ enabled: true, listening: true });
    expect(new SettingsService(settingsFile).get().localAgentAccessEnabled).toBe(true);
    expect(await service.setEnabled(false)).toMatchObject({ enabled: false, listening: false });
    expect(new SettingsService(settingsFile).get().localAgentAccessEnabled).toBe(false);
  } finally { await service.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
