import fc from "fast-check";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {} }));
import { resolveMcpExecutable } from "./mcp-executable";
function check(parts: string[], platform: string) {
  const directory = mkdtempSync(join(tmpdir(), "pg-exe-"));
  try {
    writeFileSync(join(directory, "pnpm-workspace.yaml"), "packages: [apps/*]\n");
    const appPath = join(directory, "apps", "desktop", ...parts); mkdirSync(appPath, { recursive: true });
    const roots = { appPath, platform, resourcesPath: join(directory, "Resources"), isPackaged: false };
    const name = platform === "win32" ? "pwrgit-mcp.exe" : "pwrgit-mcp";
    expect(resolveMcpExecutable(roots)).toBe(join(directory, "apps", "desktop", "build", "mcp", name));
    expect(resolveMcpExecutable({ ...roots, isPackaged: true })).toBe(join(roots.resourcesPath, name));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
it("unpackaged entry depth never changes the executable's owning checkout", () => {
  fc.assert(fc.property(fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { maxLength: 5 }), fc.constantFrom("darwin", "win32", "linux"), check));
});
it("built-entry launch resolves out/main back to the desktop build directory", () => check(["out", "main"], "darwin"));
