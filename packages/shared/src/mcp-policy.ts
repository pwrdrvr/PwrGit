export const MCP_AGENT_CAPABILITIES = [
  "repository.roots.read",
  "repository.checkout.locate",
  "repository.metadata.read",
  "forge.status.read",
  "status.subscribe",
  "app.navigate"
] as const;

export type McpAgentCapability = (typeof MCP_AGENT_CAPABILITIES)[number];
export type McpAgentPermissionDanger = "standard" | "sensitive";

export const MCP_AGENT_CAPABILITY_DETAILS: Record<
  McpAgentCapability,
  {
    label: string;
    detail: string;
    danger: McpAgentPermissionDanger;
  }
> = {
  "repository.roots.read": {
    label: "Discover repository roots",
    detail: "Inspect bounded folders where repositories may be stored.",
    danger: "standard"
  },
  "repository.checkout.locate": {
    label: "Locate checkouts",
    detail: "Match a GitHub or GitLab identity to local checkout paths.",
    danger: "sensitive"
  },
  "repository.metadata.read": {
    label: "Read repository metadata",
    detail: "Read app repositories, recent selections, branches, worktrees, and aggregate status.",
    danger: "sensitive"
  },
  "forge.status.read": {
    label: "Read forge status",
    detail: "Use the signed-in GitHub or GitLab CLI to read PR, MR, CI, and review status.",
    danger: "sensitive"
  },
  "app.navigate": {
    label: "Navigate PwrGit",
    detail: "Open or focus authorized repositories and worktrees in PwrGit windows.",
    danger: "sensitive"
  },
  "status.subscribe": {
    label: "Subscribe to live status",
    detail: "Keep MCP resources or the WebSocket fallback active for repository updates.",
    danger: "sensitive"
  }
};

export type McpAgentRole = {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  permissions: McpAgentCapability[];
  /** Null permits any repository reachable through PwrGit's bounded tools. */
  repositoryRoots: string[] | null;
};

export type McpAgentSession = {
  id: string;
  name: string;
  roleId: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  oauth?: { clientId: string; scopes: McpAgentCapability[] };
};

export type McpAgentPolicySnapshot = {
  protocol: "pwrgit.mcp-policy/v1";
  version: 1;
  policyFile: string;
  capabilities: Array<{
    capability: McpAgentCapability;
    label: string;
    detail: string;
    danger: McpAgentPermissionDanger;
  }>;
  roles: McpAgentRole[];
  sessions: McpAgentSession[];
};

export type McpAgentSessionCredential = {
  session: McpAgentSession;
  token: string;
  environment: {
    policyFileVariable: "PWRGIT_MCP_POLICY_FILE";
    policyFile: string;
    sessionTokenVariable: "PWRGIT_MCP_SESSION_TOKEN";
  };
};

export type McpAgentRoleInput = {
  name: string;
  description: string;
  permissions: McpAgentCapability[];
  repositoryRoots: string[] | null;
};

export type McpAgentRolePatch = Partial<McpAgentRoleInput>;

export type AgentAccessSnapshot = {
  enabled: boolean;
  listening: boolean;
  mcpUrl: string;
  error?: string;
};

export type AgentConsentPrompt = {
  requestId: string;
  clientName: string;
  sessionName: string;
  roles: McpAgentRole[];
};

export type AgentConsentDecision = {
  requestId: string;
  decision: "allow" | "deny";
  sessionName: string;
  roleId: string;
};
