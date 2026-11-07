import { createRoot } from "react-dom/client";
import { ok, MCP_AGENT_CAPABILITIES, MCP_AGENT_CAPABILITY_DETAILS } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { SettingsSectionStack } from "../../../src/renderer/src/features/settings/SettingsLayout";
import { LocalAgentsSettings } from "../../../src/renderer/src/features/settings/LocalAgentsSettings";
import { AgentAccessSection } from "../../../src/renderer/src/features/settings/AgentAccessSection";

// Contrived credentials, paths and status. No app, OS listener or real grant.
const policy = {
  protocol: "pwrgit.mcp-policy/v1", version: 1, policyFile: "/Users/demo/Library/Application Support/PwrGit/mcp-policy.json",
  capabilities: MCP_AGENT_CAPABILITIES.map(capability => ({ capability, ...MCP_AGENT_CAPABILITY_DETAILS[capability] })),
  roles: [{ id: "role-demo", name: "Repository observer", builtIn: false, description: "Current role", permissions: [...MCP_AGENT_CAPABILITIES], repositoryRoots: null }],
  sessions: [{ id: "session-demo", name: "Editor observer", roleId: "role-demo", createdAt: "2026-11-07T18:00:00Z", updatedAt: "2026-11-07T18:00:00Z", revokedAt: null,
    consent: { permissions: ["repository.metadata.read"], repositoryRoots: ["/Users/demo/src"] } }]
};
const snapshot = {
  enabled: true, listening: true, platform: "darwin",
  executable: "/Applications/PwrGit.app/Contents/Resources/pwrgit-mcp",
  mcpUrl: "unix:///tmp/pwrgit-mcp-501/mcp.sock#/mcp"
};
(window as unknown as { pwrgit: unknown }).pwrgit = {
  platform: "darwin", profileId: "demo", appearance: { theme: "light", resolvedTheme: "light" },
  dispatch: async (command: string) => ok(command === "localAgents:read" ? policy : command === "agentAccess:bootstrapHttp"
    ? { token: "contrived-credential-not-a-real-secret", expiresAt: "2026-11-07T18:02:00Z" } : snapshot),
  on: () => () => undefined
};
document.documentElement.dataset["theme"] = "light";
document.documentElement.style.cssText = "overflow:auto;height:auto";
document.body.style.cssText = "overflow:auto;height:auto;background:var(--bg);";
document.getElementById("root")!.style.cssText = "overflow:visible;height:auto";
createRoot(document.getElementById("root")!).render(<main style={{ maxWidth: 980, margin: "32px auto", padding: 24 }}>
  {new URLSearchParams(location.search).has("graph") ? <LocalAgentsSettings /> : <><h1>Local Agents</h1><SettingsSectionStack paneId="local-agents" aria-label="Local agents connection settings"><AgentAccessSection /></SettingsSectionStack></>}
</main>);
