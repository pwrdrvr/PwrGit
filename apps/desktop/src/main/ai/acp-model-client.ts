// ACP model listing for the AI pages' pickers — PwrSnap's pre-pool
// `acp:models` path: a short-lived kit `AcpOneShotClient` over the agent's own
// stdio, whose `listModels()` opens a throwaway session, reads the models the
// agent advertises on `session/new`, and is closed straight after.
//
// This is the one discovery-side call that starts an agent in ACP mode, which
// is why the AI pages only ask for agents a job is routed to (or ones the
// operator refreshed), and why results are cached on disk.

import { mkdirSync } from "node:fs";
import {
  AcpConnection,
  AcpOneShotClient,
  type AcpAgentStrategy
} from "@pwrdrvr/agent-acp";
import type { AcpAgentModelOption } from "@pwrgit/shared";
import {
  PWRGIT_CLIENT_NAME,
  PWRGIT_CLIENT_TITLE,
  toAgentKitLogger
} from "./agent-kit-bindings";

export type AcpModelLister = (input: {
  strategy: AcpAgentStrategy;
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Scratch working directory for the session — never a repository. */
  cwd: string;
}) => Promise<AcpAgentModelOption[]>;

export const listAcpModels: AcpModelLister = async ({
  strategy,
  command,
  args,
  env,
  cwd
}) => {
  const logger = toAgentKitLogger(`ai:acp-models:${strategy.id}`);
  mkdirSync(cwd, { recursive: true });
  const client = new AcpOneShotClient({
    transport: new AcpConnection({ command, args: [...args], env, logger }),
    strategy,
    clientName: PWRGIT_CLIENT_NAME,
    clientTitle: PWRGIT_CLIENT_TITLE,
    cwd,
    logger
  });
  try {
    const models = await client.listModels();
    return models.map((model) => ({
      id: model.id,
      label: model.label ?? model.id,
      ...(model.description !== undefined ? { description: model.description } : {}),
      ...(model.isDefault === true ? { isDefault: true } : {})
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
};
