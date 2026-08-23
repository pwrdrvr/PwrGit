import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  McpError,
  type CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CommandRunner } from "./command.js";
import {
  discoverRepositoryRoots,
  findRepositoryCheckouts
} from "./discovery.js";
import {
  createLiveStatusLoader,
  type LiveStatusLoader
} from "./forge-status.js";
import { readRepositoryInfo } from "./git-metadata.js";
import { LiveEventServer } from "./live-events.js";
import { StatusResourceRegistry } from "./status-resources.js";
import {
  McpAccessError,
  PolicyFileAuthorizer,
  type McpAuthorization,
  type McpAuthorizationRequirement,
  type McpAuthorizer
} from "./access-policy.js";

export const CAPABILITY_RESOURCE_URI = "pwrgit://live-status/capabilities/v1";

export type PwrGitMcpServerOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  liveStatusLoader?: LiveStatusLoader;
  authorizer?: McpAuthorizer;
};

export type PwrGitMcpServer = {
  mcp: McpServer;
  eventServer: LiveEventServer;
  statusResources: StatusResourceRegistry;
  close: () => Promise<void>;
};

function success(value: unknown, message: string): CallToolResult {
  const structuredContent =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : { value };
  return {
    content: [{ type: "text", text: message }],
    structuredContent
  };
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

const liveWatchAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
} as const;

export async function createPwrGitMcpServer(
  options: PwrGitMcpServerOptions = {}
): Promise<PwrGitMcpServer> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const authorizer = options.authorizer ?? PolicyFileAuthorizer.fromEnvironment(env);
  const initialAuthorization = await requireAccess(authorizer);
  const liveStatusLoader =
    options.liveStatusLoader ?? createLiveStatusLoader(options.runner);
  const eventServer = new LiveEventServer(
    liveStatusLoader,
    authorizer,
    initialAuthorization
  );
  await eventServer.start();

  const mcp = new McpServer(
    { name: "PwrGit", version: "0.1.0" },
    {
      instructions:
        "PwrGit provides bounded, read-only discovery of local GitHub and GitLab checkouts. " +
        "Remote credentials and changed-file paths are never returned. For live status, call pwrgit_watch_repository, read its versioned resource, subscribe with resources/subscribe, and re-read it after notifications/resources/updated. " +
        "Use the advertised WebSocket only when the host cannot surface standard MCP resource subscriptions."
    }
  );
  const statusResources = new StatusResourceRegistry(
    mcp,
    liveStatusLoader,
    authorizer
  );

  mcp.registerResource(
    "pwrgit-live-status-capabilities",
    CAPABILITY_RESOURCE_URI,
    {
      title: "PwrGit live status capabilities v1",
      description:
        "Capability discovery for standard MCP subscribable status resources and the optional WebSocket fallback.",
      mimeType: "application/json"
    },
    async (uri) => {
      const authorization = await requireAccess(authorizer, {
        capabilities: ["forge.status.read", "status.subscribe"]
      });
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(eventServer.capabilities(authorization))
          }
        ]
      };
    }
  );

  mcp.registerTool(
    "pwrgit_repository_roots",
    {
      title: "Discover repository roots",
      description:
        "Find bounded folders where this user appears to keep Git repositories. Uses PWRGIT_MCP_ROOTS, caller-provided roots, a safe current-workspace parent, and existing conventional folders; never selects a home directory or filesystem root automatically.",
      inputSchema: {
        roots: z
          .array(z.string().trim().min(1).max(4_096))
          .max(32)
          .optional()
          .describe("Additional absolute roots to inspect."),
        includeConventional: z
          .boolean()
          .optional()
          .describe("Include existing conventional folders such as ~/src and ~/projects (default true)."),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .describe("Maximum directory depth per root (default 4, hard maximum 5).")
      },
      annotations: readOnlyAnnotations
    },
    async (input) => {
      let authorization = await requireAccess(authorizer, {
        capabilities: ["repository.roots.read"]
      });
      if (input.roots !== undefined) {
        authorization = await requireAccess(authorizer, {
          capabilities: ["repository.roots.read"],
          repositoryPaths: input.roots
        });
      }
      const restricted = authorization.repositoryRoots !== null;
      const requestedRoots =
        input.roots ??
        (authorization.repositoryRoots === null
          ? undefined
          : [...authorization.repositoryRoots]);
      const result = await discoverRepositoryRoots({
        ...(requestedRoots === undefined ? {} : { requested: requestedRoots }),
        includeConventional: restricted
          ? false
          : (input.includeConventional ?? true),
        includeConfigured: !restricted,
        includeCurrentWorkspace: !restricted,
        ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
        cwd,
        env,
        ...(options.runner === undefined ? {} : { runner: options.runner })
      });
      return success(
        result,
        `PwrGit inspected ${result.roots.length} bounded repository root${result.roots.length === 1 ? "" : "s"}. See structuredContent for paths and scan limits.`
      );
    }
  );

  mcp.registerTool(
    "pwrgit_find_checkout",
    {
      title: "Find a local checkout",
      description:
        "Locate bounded local checkouts whose credential-free remote identity matches a GitHub or GitLab repository.",
      inputSchema: {
        repository: z
          .string()
          .trim()
          .min(3)
          .max(1_000)
          .describe("owner/name, host/owner/name, or a GitHub/GitLab remote URL."),
        provider: z.enum(["github", "gitlab"]).optional(),
        roots: z
          .array(z.string().trim().min(1).max(4_096))
          .max(32)
          .optional()
          .describe(
            "When supplied, search only these roots; otherwise use configured, workspace, and conventional candidates."
          ),
        maxDepth: z.number().int().min(0).max(5).optional(),
        maxResults: z.number().int().min(1).max(20).optional()
      },
      annotations: readOnlyAnnotations
    },
    async (input) => {
      let authorization = await requireAccess(authorizer, {
        capabilities: ["repository.checkout.locate"]
      });
      if (input.roots !== undefined) {
        authorization = await requireAccess(authorizer, {
          capabilities: ["repository.checkout.locate"],
          repositoryPaths: input.roots
        });
      }
      const roots =
        input.roots ??
        (authorization.repositoryRoots === null
          ? undefined
          : [...authorization.repositoryRoots]);
      const result = await findRepositoryCheckouts({
        repository: input.repository,
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(roots === undefined ? {} : { roots }),
        ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
        ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
        cwd,
        env,
        ...(options.runner === undefined ? {} : { runner: options.runner })
      });
      return success(
        result,
        `PwrGit found ${result.matches.length} matching checkout${result.matches.length === 1 ? "" : "s"}. See structuredContent for credential-free identities and local paths.`
      );
    }
  );

  mcp.registerTool(
    "pwrgit_repository_info",
    {
      title: "Inspect repository metadata",
      description:
        "Read canonical provider identity, credential-free remotes, fork/upstream evidence, worktrees, branches, and safe aggregate status. Does not return filenames, commit messages, author data, or remote credentials.",
      inputSchema: {
        path: z.string().trim().min(1).max(4_096)
      },
      annotations: readOnlyAnnotations
    },
    async (input) => {
      await requireAccess(authorizer, {
        capabilities: ["repository.metadata.read"],
        repositoryPaths: [input.path]
      });
      const result = await readRepositoryInfo(input.path, options.runner);
      return success(
        result,
        `PwrGit inspected ${result.worktreeCount} worktree${result.worktreeCount === 1 ? "" : "s"} for ${result.canonicalRemote?.path ?? result.repositoryPath}. See structuredContent for safe status counts.`
      );
    }
  );

  mcp.registerTool(
    "pwrgit_watch_repository",
    {
      title: "Create a subscribable live status resource",
      description:
        "Create and initially read a versioned MCP resource for normalized local, PR/MR, CI, merge-conflict, review, and PR/MR state. Subscribe to resourceUri with resources/subscribe and re-read after notifications/resources/updated.",
      inputSchema: {
        path: z.string().trim().min(1).max(4_096),
        intervalMs: z
          .number()
          .int()
          .min(5_000)
          .max(300_000)
          .optional()
          .describe("Polling cadence for a subscribed resource (default 15000ms).")
      },
      annotations: liveWatchAnnotations
    },
    async (input) => {
      await requireAccess(authorizer, {
        capabilities: ["forge.status.read", "status.subscribe"],
        repositoryPaths: [input.path]
      });
      const document = await statusResources.create(input.path, input.intervalMs);
      return {
        content: [
          {
            type: "text",
            text:
              "PwrGit live status resource is ready. Read the attached resource, subscribe to its URI, and re-read it after notifications/resources/updated."
          },
          {
            type: "resource_link",
            uri: document.resourceUri,
            name: "PwrGit live repository status v1",
            description:
              "Subscribe with resources/subscribe, then re-read after notifications/resources/updated.",
            mimeType: "application/json"
          }
        ],
        structuredContent: document as unknown as Record<string, unknown>
      };
    }
  );

  mcp.registerTool(
    "pwrgit_live_status_capabilities",
    {
      title: "Discover live status capabilities",
      description:
        "Describe the primary standard MCP resource-subscription path, normalized status/event states, and optional versioned WebSocket fallback.",
      inputSchema: {},
      annotations: readOnlyAnnotations
    },
    async () => {
      const authorization = await requireAccess(authorizer, {
        capabilities: ["forge.status.read", "status.subscribe"]
      });
      return success(
        eventServer.capabilities(authorization),
        `PwrGit live status uses standard MCP subscriptions first. The same contract is readable at ${CAPABILITY_RESOURCE_URI}; an optional WebSocket fallback is included in structuredContent.`
      );
    }
  );

  let closed = false;
  return {
    mcp,
    eventServer,
    statusResources,
    close: async () => {
      if (closed) return;
      closed = true;
      statusResources.close();
      await eventServer.close();
      await mcp.close().catch(() => undefined);
    }
  };
}

async function requireAccess(
  authorizer: McpAuthorizer,
  requirement: McpAuthorizationRequirement = {}
): Promise<McpAuthorization> {
  try {
    return await authorizer.authorize(requirement);
  } catch (cause) {
    if (cause instanceof McpAccessError) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `PwrGit MCP access denied (${cause.code}): ${cause.message}`
      );
    }
    throw cause;
  }
}
