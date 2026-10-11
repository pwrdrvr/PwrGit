import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Git Bash also runs these fixtures in Windows CI; use slash-separated paths.
const bashPath = (path) => path.replaceAll("\\", "/");
const script = bashPath(fileURLToPath(new URL("./dependency-setup-timing.sh", import.meta.url)));

test.each(["success", "failure", "cancelled"])("reports elapsed setup time after %s without action outputs", (outcome) => {
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-setup-timing-"));
  try {
    const output = join(directory, "output");
    const summary = join(directory, "summary");
    const env = { ...process.env, GITHUB_OUTPUT: bashPath(output), GITHUB_STEP_SUMMARY: bashPath(summary) };
    const started = spawnSync("bash", [script, "start"], { env, encoding: "utf8" });
    expect(started.status, started.stderr).toBe(0);
    const timestamp = Number(readFileSync(output, "utf8").match(/^started-at=(\d+)\n$/)[1]);
    expect(Math.abs(timestamp - Math.floor(Date.now() / 1000))).toBeLessThan(5);
    // Missing configure-nodejs outputs model an interrupted composite action.
    const reported = spawnSync("bash", [script, "report"], {
      env: { ...env, DEPENDENCY_SETUP_STARTED_AT: String(timestamp - 600),
        DEPENDENCY_SETUP_OUTCOME: outcome, DEPENDENCY_SETUP_TIMEOUT_MINUTES: "10" },
      encoding: "utf8",
    });
    expect(reported.status, reported.stderr).toBe(0);
    expect(reported.stdout).toContain(`::notice::Dependency setup: outcome=${outcome}; elapsed=60`);
    const body = readFileSync(summary, "utf8");
    expect(body).toContain(`outcome=${outcome};`);
    expect(body).toContain("timeout=10m (includes cache, Node.js, Corepack and install).");
    const elapsed = Number(body.match(/elapsed=(\d+)s/)[1]);
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(605);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
