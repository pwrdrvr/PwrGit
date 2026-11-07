/** PwrGit's loopback MCP endpoint. PwrSnap uses port 51729. */
export const AGENT_ACCESS_PORT = 51731;
export const AGENT_ACCESS_MCP_PATH = "/mcp";
/** Full-duplex byte relay; versioned independently of either product release. */
export const MCP_RELAY_PATH = "/mcp/stdio";
export const MCP_RELAY_PROTOCOL = "pwrgit.mcp-relay.v1";
export const MCP_DESKTOP_VERSION_HEADER = "x-pwrgit-desktop-version";
