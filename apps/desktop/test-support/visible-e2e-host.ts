import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type HostObservation = {
  githubActions?: string;
  platform: NodeJS.Platform;
  model: string;
  home: string;
  checkout: string;
  lockRunId: string;
};

// This prevents accidental local launches; it does not grant lab access.
// Control still authorizes the caller and claims the dedicated guest display.
export function visibleE2EHostAllowed(host: HostObservation): boolean {
  if (host.githubActions === "true") return true;
  return host.platform === "darwin"
    && /^VirtualMac\d+,\d+$/.test(host.model)
    && /^mcp-e2e-[0-9a-f]{32}$/.test(host.lockRunId)
    && host.checkout === join(host.home, "PwrLab", "runs", host.lockRunId, "checkout");
}

export function assertVisibleE2EHost(): void {
  // Keep GitHub Actions' existing Linux/xvfb, Windows and macOS runner paths.
  // Generic CI=true is often used locally and is deliberately insufficient.
  if (process.env.GITHUB_ACTIONS === "true") return;
  try {
    const home = realpathSync(homedir());
    const checkout = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
    const lockRunId = readFileSync(join(home, "PwrLab", "locks", "e2e", "run-id"), "utf8").trim();
    const model = execFileSync("/usr/sbin/sysctl", ["-n", "hw.model"], {
      encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (visibleE2EHostAllowed({ platform: process.platform, model, home, checkout, lockRunId })) return;
  } catch {
    // Missing ownership, unknown hardware or an unreadable path fails closed.
  }
  throw new Error(
    "Visible Electron E2E requires the dedicated PwrSuiteLab VM through Control MCP. "
    + "Discover lab_status and submit this clean committed worktree with lab_e2e_run; it starts the VM when needed. "
    + "Report unavailable access or ownership instead of running on the physical desktop. "
    + "See docs/headed-e2e-pwrsuitelab.md. Hidden harnesses remain local."
  );
}
