import { beginGitDiagnostic } from "../git-diagnostics";

/** Persist begin before entering execFileSync and end after return/throw.
 * The test journal's independent watchdog can inspect the outstanding call;
 * there is no ChildProcess handle or stream-event observation for this API. */
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
