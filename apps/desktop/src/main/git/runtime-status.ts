import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ok, type Res } from "@pwrgit/shared";
import { cliSearchPath } from "../forge/cli-runner";
import type { CommandBus } from "../command-bus";
import { bundledGitPath, execGit, type GitExec } from "./dugite";

type Status = Res<"git:runtimeStatus">;

/** Discovery reports the first installed executable on the CLI search path;
 * it never changes the Git runtime used by repository operations. */
export async function installedVersion(binary: "git" | "git-lfs"): Promise<string | null> {
  const paths = cliSearchPath().split(delimiter).filter(Boolean);
  for (const directory of paths) {
    const path = join(directory, process.platform === "win32" ? `${binary}.exe` : binary);
    try { await access(path, constants.X_OK); } catch { continue; }
    return new Promise((resolve) => {
      execFile(path, ["--version"], {
        cwd: tmpdir(), timeout: 5_000, maxBuffer: 16_384, windowsHide: true
      }, (error, stdout) => resolve(error === null ? stdout.trim() : null));
    });
  }
  return null;
}

export async function readGitRuntimeStatus(
  git: GitExec = execGit,
  installed = installedVersion
): Promise<Status> {
  const version = async (args: string[]): Promise<string | null> => {
    const result = await git(args, tmpdir(), { signal: AbortSignal.timeout(5_000) });
    return result.ok && result.value.exitCode === 0 ? result.value.stdout.trim() : null;
  };
  const [gitVersion, lfsVersion, installedGit, installedLfs] = await Promise.all([
    version(["--version"]), version(["lfs", "version"]), installed("git"), installed("git-lfs")
  ]);
  return {
    active: "bundled", default: "bundled", path: bundledGitPath(),
    bundled: { git: gitVersion, lfs: lfsVersion },
    installed: { git: installedGit, lfs: installedLfs }
  };
}

export function registerGitRuntimeHandlers(bus: CommandBus): void {
  // Coalesce StrictMode/concurrent windows without persisting discovery results.
  let pending: Promise<Status> | undefined;
  bus.register("git:runtimeStatus", async () => {
    pending ??= readGitRuntimeStatus().finally(() => { pending = undefined; });
    return ok(await pending);
  });
}
