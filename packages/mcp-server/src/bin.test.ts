import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
it("retired standalone clients exit with native migration instructions and no MCP output", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./bin.ts", import.meta.url))], {
    encoding: "utf8", env: { ...process.env, PWRGIT_MCP_SESSION_TOKEN: "retained-legacy-credential" }
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("native relay command");
  expect(result.stderr).toContain("Open PwrGit yourself");
});
