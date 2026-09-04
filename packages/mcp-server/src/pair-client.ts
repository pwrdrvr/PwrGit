import {
  AGENT_ACCESS_HEALTH_PATH,
  AGENT_ACCESS_PAIR_POLL_PATH,
  AGENT_ACCESS_PAIR_REQUEST_PATH,
  AGENT_ACCESS_PORT,
  type AgentAccessHealth,
  type PairingPollResponse,
  type PairingTicket
} from "./agent-access-protocol.js";

export type PairResult = {
  token: string;
  policyFile: string;
  mcpUrl: string;
  session: { id: string; name: string; roleId: string };
};

export class PairError extends Error {
  constructor(
    readonly code:
      | "app_unreachable"
      | "denied"
      | "expired"
      | "timeout"
      | "bad_response",
    message: string
  ) {
    super(message);
    this.name = "PairError";
  }
}

export function agentAccessBaseUrl(port: number = AGENT_ACCESS_PORT): string {
  return `http://127.0.0.1:${port}`;
}

/** Reachability probe. A client should call this before pairing so it can tell
 * "PwrGit is not running" apart from "the operator said no". */
export async function readAgentAccessHealth(
  options: { port?: number; fetch?: typeof globalThis.fetch } = {}
): Promise<AgentAccessHealth> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = agentAccessBaseUrl(options.port);
  let response: Response;
  try {
    response = await doFetch(`${base}${AGENT_ACCESS_HEALTH_PATH}`);
  } catch (cause) {
    throw new PairError(
      "app_unreachable",
      `PwrGit is not accepting agent connections on ${base}. Open PwrGit and turn on Settings > Agents > Local agent access. (${
        cause instanceof Error ? cause.message : String(cause)
      })`
    );
  }
  if (!response.ok) {
    throw new PairError("bad_response", `PwrGit returned HTTP ${response.status}.`);
  }
  return (await response.json()) as AgentAccessHealth;
}

/** Runs the full consent handshake: ask, then poll until the operator answers
 * in the PwrGit window. Nothing is minted until they approve. */
export async function pairWithPwrGit(options: {
  clientName: string;
  requestedRoleId?: string;
  port?: number;
  fetch?: typeof globalThis.fetch;
  /** Called once with the pending ticket so a caller can tell the user to go
   * look at PwrGit. */
  onPending?: (ticket: PairingTicket) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<PairResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const base = agentAccessBaseUrl(options.port);

  await readAgentAccessHealth({
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });

  const requested = await doFetch(`${base}${AGENT_ACCESS_PAIR_REQUEST_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientName: options.clientName,
      ...(options.requestedRoleId === undefined
        ? {}
        : { requestedRoleId: options.requestedRoleId })
    })
  });
  if (!requested.ok) {
    throw new PairError(
      "bad_response",
      `PwrGit refused the pairing request (HTTP ${requested.status}).`
    );
  }
  const ticket = (await requested.json()) as PairingTicket;
  options.onPending?.(ticket);

  const deadline = Date.parse(ticket.expiresAt);
  const interval = Math.max(ticket.pollIntervalMs, 250);
  while (now() < deadline) {
    await sleep(interval);
    const polled = await doFetch(
      `${base}${AGENT_ACCESS_PAIR_POLL_PATH}?pairingId=${encodeURIComponent(ticket.pairingId)}`
    );
    if (!polled.ok) {
      throw new PairError(
        "bad_response",
        `PwrGit returned HTTP ${polled.status} while polling.`
      );
    }
    const result = (await polled.json()) as PairingPollResponse;
    if (result.status === "pending") continue;
    if (result.status === "denied") {
      throw new PairError("denied", result.reason);
    }
    if (result.status === "expired") {
      throw new PairError(
        "expired",
        "The pairing request expired before it was approved."
      );
    }
    return {
      token: result.token,
      policyFile: result.policyFile,
      mcpUrl: result.mcpUrl,
      session: result.session
    };
  }
  throw new PairError(
    "timeout",
    "PwrGit was not approved in time. Run the command again and approve it in the PwrGit window."
  );
}
