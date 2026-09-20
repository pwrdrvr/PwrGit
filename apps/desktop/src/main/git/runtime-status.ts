import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ok, type Res } from "@pwrgit/shared";
import { cliSearchPath } from "../forge/cli-runner";
import type { CommandBus } from "../command-bus";
import { bundledGitPath, execGit, type GitExec } from "./dugite";

type Status = Res<"git:runtimeStatus">;

function probeOutput(path: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, args, {
      cwd: tmpdir(), timeout: 5_000, maxBuffer: 16_384, windowsHide: true
    }, (error, stdout) => resolve(error === null ? stdout.trim() || null : null));
  });
}

/** Discovery reports the first installed executable on the CLI search path;
 * it never changes the Git runtime used by repository operations. */
export async function installedVersion(binary: "git" | "git-lfs"): Promise<string | null> {
  const paths = cliSearchPath().split(delimiter).filter(Boolean);
  for (const directory of paths) {
    let path = join(directory, process.platform === "win32" ? `${binary}.exe` : binary);
    try { await access(path, constants.X_OK); } catch { continue; }
    if (process.platform === "darwin" && binary === "git") {
      let resolved: string;
      try { resolved = await realpath(path); } catch { continue; }
      if (resolved === "/usr/bin/git") {
        // Apple's shim can open the developer-tools installer. Inspect the
        // selection without invoking the shim, including through a symlink.
        const developerDir = await probeOutput("/usr/bin/xcode-select", ["-p"]);
        if (developerDir === null) continue;
        path = join(developerDir, "usr", "bin", "git");
        try { await access(path, constants.X_OK); } catch { continue; }
        // Probe the actual tool so a removed/stale selection cannot trigger
        // the install dialog between checking availability and execution.
      }
    }
    return probeOutput(path, ["--version"]);
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
