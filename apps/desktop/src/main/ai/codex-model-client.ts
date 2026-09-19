// Codex model listing for the AI pages' pickers. Ported from PwrSnap's
// `codex-model-client.ts`, which routes through its app-wide Codex pool.
// PwrGit has no pool, so this is the short-lived form: start Codex's App
// Server, `initialize`, page through `model/list`, close.
//
// It speaks JSON-RPC through @pwrdrvr/agent-transport rather than calling the
// kit's `CodexOneShotClient.listModels()`, because the kit's model mapping
// drops `supportedReasoningEfforts` and `defaultReasoningEffort` — the very
// fields that tell the Reasoning picker which efforts a model accepts. The
// `initialize` params are the kit's own.
//
// `CodexModelLister` is the seam: once something in main owns a long-lived
// Codex process, it can list models through that process instead.

import { JsonRpcConnection, StdioJsonRpcTransport } from "@pwrdrvr/agent-transport";
import { isAiReasoningEffort, type CodexModelOption } from "@pwrgit/shared";
import {
  PWRGIT_CLIENT_NAME,
  PWRGIT_CLIENT_TITLE,
  toAgentKitLogger
} from "./agent-kit-bindings";

export type CodexModelLister = (input: {
  command: string;
  env: NodeJS.ProcessEnv;
  includeHidden: boolean;
}) => Promise<CodexModelOption[]>;

const REQUEST_TIMEOUT_MS = 20_000;
/** `model/list` pages are 100 long; a list longer than this is a server bug,
 *  and a cursor that never ends must not spin the main process forever. */
const MAX_PAGES = 20;

export const listCodexModels: CodexModelLister = async ({
  command,
  env,
  includeHidden
}) => {
  const logger = toAgentKitLogger("ai:codex-models");
  const connection = new JsonRpcConnection(
    new StdioJsonRpcTransport({ command, args: ["app-server"], env, logger }),
    REQUEST_TIMEOUT_MS,
    undefined,
    { logger, logContext: { owner: "pwrgit-codex-models" } }
  );
  try {
    await connection.connect();
    await connection.request("initialize", {
      clientInfo: {
        name: PWRGIT_CLIENT_NAME,
        title: PWRGIT_CLIENT_TITLE,
        version: "0.0.0"
      },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    const models: CodexModelOption[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = (await connection.request("model/list", {
        cursor,
        limit: 100,
        includeHidden
      })) as { data?: unknown; nextCursor?: unknown };
      const data = Array.isArray(response.data) ? response.data : [];
      models.push(...data.map(toCodexModelOption).filter((model) => model.id.length > 0));
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
      if (cursor === null) break;
    }
    return models;
  } finally {
    await connection.close().catch(() => undefined);
  }
};

/**
 * One `model/list` entry, read defensively — it arrives from whatever Codex
 * build is installed. Efforts may be plain strings or `{ reasoningEffort }`
 * records depending on the build; both are accepted, and anything that is not
 * a well-formed effort is dropped rather than offered.
 */
export function toCodexModelOption(raw: unknown): CodexModelOption {
  const model = (typeof raw === "object" && raw !== null ? raw : {}) as {
    id?: unknown;
    model?: unknown;
    displayName?: unknown;
    description?: unknown;
    hidden?: unknown;
    supportedReasoningEfforts?: unknown;
    defaultReasoningEffort?: unknown;
    isDefault?: unknown;
  };
  const id = typeof model.id === "string" ? model.id : "";
  const supportedReasoningEfforts = Array.isArray(model.supportedReasoningEfforts)
    ? [
        ...new Set(
          model.supportedReasoningEfforts
            .map((item: unknown) =>
              typeof item === "string"
                ? item
                : typeof item === "object" && item !== null
                  ? (item as { reasoningEffort?: unknown }).reasoningEffort
                  : undefined
            )
            .filter(isAiReasoningEffort)
        )
      ]
    : [];
  return {
    id,
    model: typeof model.model === "string" ? model.model : id,
    displayName: typeof model.displayName === "string" ? model.displayName : id,
    description: typeof model.description === "string" ? model.description : "",
    hidden: model.hidden === true,
    supportedReasoningEfforts,
    defaultReasoningEffort: isAiReasoningEffort(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : null,
    isDefault: model.isDefault === true
  };
}
