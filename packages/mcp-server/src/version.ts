import metadata from "../package.json" with { type: "json" };

/** Works from both src/ and dist/; this is the relay/library release, not Electron's. */
export const MCP_PACKAGE_VERSION = metadata.version;
