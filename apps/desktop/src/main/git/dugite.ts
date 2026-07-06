// dugite is CommonJS; default-import + destructure so the strict-ESM main
// bundle loads it (a named `import { exec }` throws at runtime).
import dugite from "dugite";
import { err, ok, type PwrGitError, type Result } from "@pwrgit/shared";

const { exec } = dugite;

export type GitOutput = { stdout: string; stderr: string; exitCode: number };

/**
 * Runs a git command in `cwd` and resolves to the process output. Injected
 * everywhere git is needed so callers stay decoupled from dugite — tests pass
 * a system-git-backed exec instead of dugite's bundled binary.
 *
 * A completed process (any exit code) resolves to `ok`; only a spawn failure
 * resolves to `err`. Callers inspect `exitCode` when non-zero matters.
 */
export type GitExec = (
  args: string[],
  cwd: string
) => Promise<Result<GitOutput, PwrGitError>>;

/** Production GitExec backed by dugite's bundled git binary (KTD1). */
export const execGit: GitExec = async (args, cwd) => {
  try {
    const result = await exec(args, cwd);
    return ok({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    });
  } catch (cause) {
    return err({
      kind: "git",
      code: "spawn_failed",
      message: cause instanceof Error ? cause.message : String(cause),
      cause
    });
  }
};

/** Turn a non-zero git exit into a typed error; pass through ok output. */
export function requireExit0(
  output: GitOutput,
  args: string[]
): Result<GitOutput, PwrGitError> {
  if (output.exitCode !== 0) {
    return err({
      kind: "git",
      code: `exit_${output.exitCode}`,
      message:
        output.stderr.trim() !== ""
          ? output.stderr.trim()
          : `git ${args.join(" ")} exited ${output.exitCode}`
    });
  }
  return ok(output);
}
