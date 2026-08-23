import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

export const MCP_POLICY_PROTOCOL = "pwrgit.mcp-policy/v1" as const;
export const MCP_POLICY_VERSION = 1 as const;

export const MCP_AGENT_CAPABILITIES = [
  "repository.roots.read",
  "repository.checkout.locate",
  "repository.metadata.read",
  "forge.status.read",
  "status.subscribe"
] as const;

export type McpAgentCapability = (typeof MCP_AGENT_CAPABILITIES)[number];
export type McpAgentPermissionDanger = "standard" | "sensitive";

export const MCP_AGENT_CAPABILITY_DETAILS: Record<
  McpAgentCapability,
  { label: string; detail: string; danger: McpAgentPermissionDanger }
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
    detail: "Read remotes, branches, worktrees, and aggregate working-tree status.",
    danger: "sensitive"
  },
  "forge.status.read": {
    label: "Read forge status",
    detail: "Use the signed-in GitHub or GitLab CLI to read PR, MR, CI, and review status.",
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
  repositoryRoots: string[] | null;
};

type McpAgentSessionRecord = {
  id: string;
  name: string;
  roleId: string;
  tokenHash: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

export type McpAgentSession = Omit<McpAgentSessionRecord, "tokenHash">;

export type McpPolicyFile = {
  protocol: typeof MCP_POLICY_PROTOCOL;
  version: typeof MCP_POLICY_VERSION;
  roles: McpAgentRole[];
  sessions: McpAgentSessionRecord[];
};

export type McpPolicySnapshot = {
  protocol: typeof MCP_POLICY_PROTOCOL;
  version: typeof MCP_POLICY_VERSION;
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

export type McpAgentRoleInput = {
  name: string;
  description: string;
  permissions: McpAgentCapability[];
  repositoryRoots: string[] | null;
};

export type McpAuthorization = {
  sessionId: string;
  sessionName: string;
  roleId: string;
  roleName: string;
  capabilities: readonly McpAgentCapability[];
  repositoryRoots: readonly string[] | null;
};

export type McpAuthorizationRequirement = {
  capabilities?: readonly McpAgentCapability[];
  repositoryPaths?: readonly string[];
};

export interface McpAuthorizer {
  authorize(requirement?: McpAuthorizationRequirement): Promise<McpAuthorization>;
}

export type McpAccessErrorCode =
  | "missing_session_token"
  | "policy_unavailable"
  | "invalid_policy"
  | "invalid_session"
  | "revoked_session"
  | "invalid_role"
  | "missing_capability"
  | "repository_outside_scope"
  | "invalid_input";

export class McpAccessError extends Error {
  constructor(
    readonly code: McpAccessErrorCode,
    message: string
  ) {
    super(message);
    this.name = "McpAccessError";
  }
}

export const BUILT_IN_MCP_ROLES = [
  {
    id: "builtin.discovery",
    name: "Repository Discovery",
    description: "Find bounded repository roots and locate matching checkouts.",
    builtIn: true,
    permissions: ["repository.roots.read", "repository.checkout.locate"],
    repositoryRoots: null
  },
  {
    id: "builtin.local-reader",
    name: "Local Repository Reader",
    description: "Discover repositories and read safe local Git metadata and status.",
    builtIn: true,
    permissions: [
      "repository.roots.read",
      "repository.checkout.locate",
      "repository.metadata.read"
    ],
    repositoryRoots: null
  },
  {
    id: "builtin.live-status",
    name: "Live Forge Status",
    description: "Read local metadata plus PR, MR, CI, review, and live status updates.",
    builtIn: true,
    permissions: [...MCP_AGENT_CAPABILITIES],
    repositoryRoots: null
  }
] as const satisfies readonly McpAgentRole[];

const MAX_ROLES = 128;
const MAX_SESSIONS = 256;
const MAX_ROOTS = 32;
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const TOKEN_PREFIX = "pgmcp_";

export function defaultMcpPolicyFile(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  const configured = env.PWRGIT_MCP_POLICY_FILE?.trim();
  if (configured !== undefined && configured !== "") return resolve(configured);
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    return join(appData && appData !== "" ? appData : join(home, "AppData", "Roaming"), "PwrGit", "mcp-policy.json");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "PwrGit", "mcp-policy.json");
  }
  const configHome = env.XDG_CONFIG_HOME?.trim();
  return join(configHome && configHome !== "" ? configHome : join(home, ".config"), "PwrGit", "mcp-policy.json");
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function tokenHashHex(token: string): string {
  return tokenHash(token).toString("hex");
}

function isCapability(value: unknown): value is McpAgentCapability {
  return (
    typeof value === "string" &&
    (MCP_AGENT_CAPABILITIES as readonly string[]).includes(value)
  );
}

function canonicalDirectory(path: string): string {
  if (!isAbsolute(path)) {
    throw new McpAccessError("invalid_input", "repository roots must be absolute paths");
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new McpAccessError("invalid_input", `repository root is not an existing directory: ${path}`);
  }
  return canonical;
}

function normalizedRoots(roots: readonly string[] | null): string[] | null {
  if (roots === null) return null;
  if (roots.length === 0 || roots.length > MAX_ROOTS) {
    throw new McpAccessError(
      "invalid_input",
      `a restricted role requires 1 to ${MAX_ROOTS} repository roots`
    );
  }
  const seen = new Set<string>();
  const output: string[] = [];
  for (const root of roots) {
    const canonical = canonicalDirectory(root);
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(canonical);
  }
  return output;
}

function normalizedRoleInput(input: McpAgentRoleInput): McpAgentRoleInput {
  const name = input.name.trim();
  const description = input.description.trim();
  if (name.length === 0 || name.length > 200) {
    throw new McpAccessError("invalid_input", "role name must contain 1 to 200 characters");
  }
  if (description.length > 500) {
    throw new McpAccessError("invalid_input", "role description must be 500 characters or fewer");
  }
  if (
    input.permissions.length === 0 ||
    input.permissions.length > MCP_AGENT_CAPABILITIES.length ||
    !input.permissions.every(isCapability) ||
    new Set(input.permissions).size !== input.permissions.length
  ) {
    throw new McpAccessError("invalid_input", "role permissions must be a non-empty unique capability set");
  }
  return {
    name,
    description,
    permissions: [...input.permissions],
    repositoryRoots: normalizedRoots(input.repositoryRoots)
  };
}

function publicSession(session: McpAgentSessionRecord): McpAgentSession {
  return {
    id: session.id,
    name: session.name,
    roleId: session.roleId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    revokedAt: session.revokedAt
  };
}

function cloneRole(role: McpAgentRole): McpAgentRole {
  return {
    ...role,
    permissions: [...role.permissions],
    repositoryRoots:
      role.repositoryRoots === null ? null : [...role.repositoryRoots]
  };
}

function canonicalBuiltIn(role: McpAgentRole): McpAgentRole | undefined {
  return BUILT_IN_MCP_ROLES.find((candidate) => candidate.id === role.id);
}

function roleMatchesCanonical(role: McpAgentRole): boolean {
  const canonical = canonicalBuiltIn(role);
  return (
    canonical !== undefined &&
    role.name === canonical.name &&
    role.description === canonical.description &&
    role.builtIn === canonical.builtIn &&
    JSON.stringify(role.permissions) === JSON.stringify(canonical.permissions) &&
    role.repositoryRoots === null
  );
}

function parseRole(value: unknown): McpAgentRole {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpAccessError("invalid_policy", "policy contains an invalid role");
  }
  const role = value as Partial<McpAgentRole>;
  if (
    typeof role.id !== "string" ||
    !ID_PATTERN.test(role.id) ||
    typeof role.name !== "string" ||
    typeof role.description !== "string" ||
    typeof role.builtIn !== "boolean" ||
    !Array.isArray(role.permissions) ||
    !(role.repositoryRoots === null || Array.isArray(role.repositoryRoots))
  ) {
    throw new McpAccessError("invalid_policy", "policy contains an invalid role");
  }
  let normalized: McpAgentRoleInput;
  try {
    normalized = normalizedRoleInput({
      name: role.name,
      description: role.description,
      permissions: role.permissions as McpAgentCapability[],
      repositoryRoots: role.repositoryRoots as string[] | null
    });
  } catch (cause) {
    throw new McpAccessError(
      "invalid_policy",
      cause instanceof Error ? cause.message : "policy contains an invalid role"
    );
  }
  const parsed = { id: role.id, builtIn: role.builtIn, ...normalized };
  if (parsed.builtIn && !roleMatchesCanonical(parsed)) {
    throw new McpAccessError("invalid_policy", `built-in role ${parsed.id} does not match the canonical policy`);
  }
  if (!parsed.builtIn && parsed.id.startsWith("builtin.")) {
    throw new McpAccessError("invalid_policy", "custom roles cannot use the built-in namespace");
  }
  return parsed;
}

function parseSession(value: unknown): McpAgentSessionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpAccessError("invalid_policy", "policy contains an invalid session");
  }
  const session = value as Partial<McpAgentSessionRecord>;
  if (
    typeof session.id !== "string" ||
    !ID_PATTERN.test(session.id) ||
    typeof session.name !== "string" ||
    session.name.trim().length === 0 ||
    session.name.length > 200 ||
    typeof session.roleId !== "string" ||
    !ID_PATTERN.test(session.roleId) ||
    typeof session.tokenHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(session.tokenHash) ||
    typeof session.createdAt !== "string" ||
    typeof session.updatedAt !== "string" ||
    !(session.revokedAt === null || typeof session.revokedAt === "string")
  ) {
    throw new McpAccessError("invalid_policy", "policy contains an invalid session");
  }
  return session as McpAgentSessionRecord;
}

function parsePolicy(value: unknown): McpPolicyFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpAccessError("invalid_policy", "MCP policy must be a JSON object");
  }
  const input = value as Partial<McpPolicyFile>;
  if (
    input.protocol !== MCP_POLICY_PROTOCOL ||
    input.version !== MCP_POLICY_VERSION ||
    !Array.isArray(input.roles) ||
    !Array.isArray(input.sessions) ||
    input.roles.length > MAX_ROLES ||
    input.sessions.length > MAX_SESSIONS
  ) {
    throw new McpAccessError("invalid_policy", "MCP policy protocol, version, or collection limits are invalid");
  }
  const roles = input.roles.map(parseRole);
  const sessions = input.sessions.map(parseSession);
  if (new Set(roles.map((role) => role.id)).size !== roles.length) {
    throw new McpAccessError("invalid_policy", "MCP policy contains duplicate role ids");
  }
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length) {
    throw new McpAccessError("invalid_policy", "MCP policy contains duplicate session ids");
  }
  for (const canonical of BUILT_IN_MCP_ROLES) {
    if (!roles.some((role) => role.id === canonical.id)) {
      throw new McpAccessError("invalid_policy", `MCP policy is missing ${canonical.id}`);
    }
  }
  return { protocol: MCP_POLICY_PROTOCOL, version: MCP_POLICY_VERSION, roles, sessions };
}

function emptyPolicy(): McpPolicyFile {
  return {
    protocol: MCP_POLICY_PROTOCOL,
    version: MCP_POLICY_VERSION,
    roles: BUILT_IN_MCP_ROLES.map(cloneRole),
    sessions: []
  };
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function pathInside(root: string, candidate: string): boolean {
  const fromRoot = relative(pathKey(root), pathKey(candidate));
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

export class McpPolicyStore {
  constructor(
    readonly filePath: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  initialize(): McpPolicySnapshot {
    if (!existsSync(this.filePath)) this.write(emptyPolicy());
    return this.snapshot();
  }

  snapshot(): McpPolicySnapshot {
    const policy = this.read();
    return {
      protocol: policy.protocol,
      version: policy.version,
      policyFile: this.filePath,
      capabilities: MCP_AGENT_CAPABILITIES.map((capability) => ({
        capability,
        ...MCP_AGENT_CAPABILITY_DETAILS[capability]
      })),
      roles: policy.roles.map(cloneRole),
      sessions: policy.sessions.map(publicSession)
    };
  }

  createSession(nameInput: string, roleId: string): {
    session: McpAgentSession;
    token: string;
    environment: {
      policyFileVariable: "PWRGIT_MCP_POLICY_FILE";
      policyFile: string;
      sessionTokenVariable: "PWRGIT_MCP_SESSION_TOKEN";
    };
  } {
    const policy = this.read();
    const name = nameInput.trim();
    if (name.length === 0 || name.length > 200) {
      throw new McpAccessError("invalid_input", "session name must contain 1 to 200 characters");
    }
    if (policy.sessions.length >= MAX_SESSIONS) {
      throw new McpAccessError("invalid_input", `session limit reached (${MAX_SESSIONS})`);
    }
    if (!policy.roles.some((role) => role.id === roleId)) {
      throw new McpAccessError("invalid_input", "selected role does not exist");
    }
    const timestamp = this.now().toISOString();
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const record: McpAgentSessionRecord = {
      id: `session_${randomUUID()}`,
      name,
      roleId,
      tokenHash: tokenHashHex(token),
      createdAt: timestamp,
      updatedAt: timestamp,
      revokedAt: null
    };
    policy.sessions.push(record);
    this.write(policy);
    return {
      session: publicSession(record),
      token,
      environment: {
        policyFileVariable: "PWRGIT_MCP_POLICY_FILE",
        policyFile: this.filePath,
        sessionTokenVariable: "PWRGIT_MCP_SESSION_TOKEN"
      }
    };
  }

  revokeSession(id: string): McpAgentSession {
    const policy = this.read();
    const session = policy.sessions.find((candidate) => candidate.id === id);
    if (session === undefined) throw new McpAccessError("invalid_input", "session does not exist");
    const timestamp = this.now().toISOString();
    session.revokedAt ??= timestamp;
    session.updatedAt = timestamp;
    this.write(policy);
    return publicSession(session);
  }

  assignRole(sessionId: string, roleId: string): McpAgentSession {
    const policy = this.read();
    const session = policy.sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined) throw new McpAccessError("invalid_input", "session does not exist");
    if (!policy.roles.some((role) => role.id === roleId)) {
      throw new McpAccessError("invalid_input", "selected role does not exist");
    }
    session.roleId = roleId;
    session.updatedAt = this.now().toISOString();
    this.write(policy);
    return publicSession(session);
  }

  createRole(input: McpAgentRoleInput): McpAgentRole {
    const policy = this.read();
    if (policy.roles.length >= MAX_ROLES) {
      throw new McpAccessError("invalid_input", `role limit reached (${MAX_ROLES})`);
    }
    const normalized = normalizedRoleInput(input);
    const role: McpAgentRole = {
      id: `role_${randomUUID()}`,
      builtIn: false,
      ...normalized
    };
    policy.roles.push(role);
    this.write(policy);
    return cloneRole(role);
  }

  updateRole(id: string, patch: Partial<McpAgentRoleInput>): McpAgentRole {
    const policy = this.read();
    const role = policy.roles.find((candidate) => candidate.id === id);
    if (role === undefined) throw new McpAccessError("invalid_input", "role does not exist");
    if (role.builtIn) throw new McpAccessError("invalid_input", "built-in roles are immutable; duplicate one first");
    const normalized = normalizedRoleInput({
      name: patch.name ?? role.name,
      description: patch.description ?? role.description,
      permissions: patch.permissions ?? role.permissions,
      repositoryRoots: patch.repositoryRoots === undefined ? role.repositoryRoots : patch.repositoryRoots
    });
    Object.assign(role, normalized);
    this.write(policy);
    return cloneRole(role);
  }

  deleteRole(id: string): void {
    const policy = this.read();
    const role = policy.roles.find((candidate) => candidate.id === id);
    if (role === undefined) throw new McpAccessError("invalid_input", "role does not exist");
    if (role.builtIn) throw new McpAccessError("invalid_input", "built-in roles cannot be deleted");
    if (policy.sessions.some((session) => session.roleId === id && session.revokedAt === null)) {
      throw new McpAccessError("invalid_input", "reassign every active Session before deleting this role");
    }
    policy.roles = policy.roles.filter((candidate) => candidate.id !== id);
    this.write(policy);
  }

  authorize(token: string, requirement: McpAuthorizationRequirement = {}): McpAuthorization {
    const policy = this.read();
    const suppliedHash = tokenHash(token);
    const session = policy.sessions.find((candidate) => {
      const stored = Buffer.from(candidate.tokenHash, "hex");
      return stored.length === suppliedHash.length && timingSafeEqual(stored, suppliedHash);
    });
    if (session === undefined) throw new McpAccessError("invalid_session", "MCP session token is invalid");
    if (session.revokedAt !== null) throw new McpAccessError("revoked_session", "MCP session has been revoked");
    const role = policy.roles.find((candidate) => candidate.id === session.roleId);
    if (role === undefined) throw new McpAccessError("invalid_role", "MCP session has no valid role");
    const missing = (requirement.capabilities ?? []).filter(
      (capability) => !role.permissions.includes(capability)
    );
    if (missing.length > 0) {
      throw new McpAccessError(
        "missing_capability",
        `MCP role does not grant: ${missing.join(", ")}`
      );
    }
    if (role.repositoryRoots !== null) {
      for (const requestedPath of requirement.repositoryPaths ?? []) {
        let candidate: string;
        try {
          candidate = realpathSync.native(requestedPath);
        } catch {
          throw new McpAccessError("repository_outside_scope", "repository path is unavailable or outside the assigned role");
        }
        if (!role.repositoryRoots.some((root) => pathInside(root, candidate))) {
          throw new McpAccessError("repository_outside_scope", "repository path is outside the assigned role");
        }
      }
    }
    return {
      sessionId: session.id,
      sessionName: session.name,
      roleId: role.id,
      roleName: role.name,
      capabilities: [...role.permissions],
      repositoryRoots: role.repositoryRoots === null ? null : [...role.repositoryRoots]
    };
  }

  private read(): McpPolicyFile {
    let contents: string;
    try {
      contents = readFileSync(this.filePath, "utf8");
    } catch {
      throw new McpAccessError(
        "policy_unavailable",
        `MCP policy is unavailable at ${this.filePath}; create a Session in PwrGit Settings > Agents`
      );
    }
    try {
      return parsePolicy(JSON.parse(contents) as unknown);
    } catch (cause) {
      if (cause instanceof McpAccessError) throw cause;
      throw new McpAccessError("invalid_policy", "MCP policy is not valid JSON");
    }
  }

  private write(policy: McpPolicyFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(policy, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    renameSync(temporary, this.filePath);
    if (process.platform !== "win32") chmodSync(this.filePath, 0o600);
  }
}

export class PolicyFileAuthorizer implements McpAuthorizer {
  private readonly store: McpPolicyStore;

  constructor(
    filePath: string,
    private readonly token: string
  ) {
    this.store = new McpPolicyStore(filePath);
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): PolicyFileAuthorizer {
    const token = env.PWRGIT_MCP_SESSION_TOKEN?.trim();
    if (token === undefined || token === "") {
      throw new McpAccessError(
        "missing_session_token",
        "PWRGIT_MCP_SESSION_TOKEN is required; create a Session in PwrGit Settings > Agents"
      );
    }
    return new PolicyFileAuthorizer(defaultMcpPolicyFile(env), token);
  }

  async authorize(requirement: McpAuthorizationRequirement = {}): Promise<McpAuthorization> {
    return this.store.authorize(this.token, requirement);
  }
}

/** Explicit fixed authorization for unit/integration tests and trusted embedders. */
export class FixedMcpAuthorizer implements McpAuthorizer {
  constructor(private readonly authorization: McpAuthorization) {}

  async authorize(requirement: McpAuthorizationRequirement = {}): Promise<McpAuthorization> {
    const missing = (requirement.capabilities ?? []).filter(
      (capability) => !this.authorization.capabilities.includes(capability)
    );
    if (missing.length > 0) {
      throw new McpAccessError("missing_capability", `MCP role does not grant: ${missing.join(", ")}`);
    }
    if (this.authorization.repositoryRoots !== null) {
      for (const requestedPath of requirement.repositoryPaths ?? []) {
        const candidate = realpathSync.native(requestedPath);
        if (!this.authorization.repositoryRoots.some((root) => pathInside(root, candidate))) {
          throw new McpAccessError("repository_outside_scope", "repository path is outside the assigned role");
        }
      }
    }
    return this.authorization;
  }
}

export function fullAccessAuthorization(): McpAuthorization {
  return {
    sessionId: "session_test",
    sessionName: "Test Session",
    roleId: "builtin.live-status",
    roleName: "Live Forge Status",
    capabilities: [...MCP_AGENT_CAPABILITIES],
    repositoryRoots: null
  };
}
