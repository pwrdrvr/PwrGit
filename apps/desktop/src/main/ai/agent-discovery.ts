import { existsSync } from "node:fs";
import type { AgentStatus } from "@pwrgit/shared";
import { resolveDefaultCodexHome } from "@pwrdrvr/codex-discovery";

/**
 * Report whether a linked agent (Codex) looks available. Kept fs-only (no
 * process spawn) so the Agent tab can render a status cheaply; a real
 * capability probe would run through agent-kit's discovery.
 */
export function agentStatus(): AgentStatus {
  try {
    const home = resolveDefaultCodexHome();
    if (existsSync(home)) return { available: true, home };
    return {
      available: false,
      home,
      reason: "No Codex home found — run `codex login`."
    };
  } catch (cause) {
    return {
      available: false,
      reason: cause instanceof Error ? cause.message : "agent unavailable"
    };
  }
}
