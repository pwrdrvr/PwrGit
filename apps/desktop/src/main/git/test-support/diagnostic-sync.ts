import { beginGitDiagnostic } from "../git-diagnostics";

/** execFileSync blocks JS timers. Preserve that behavior and report duration
 * on return; a slow-test timer records lateness when the loop can run again. */
export function diagnoseSyncGit<T>(args: string[], cwd: string, run: () => T): T {
  const diagnostic = beginGitDiagnostic("system-git-sync", args, cwd);
  try {
    const result = run();
    diagnostic?.settle("resolved");
    return result;
  } catch (error) {
    diagnostic?.settle("rejected");
    throw error;
  }
}
