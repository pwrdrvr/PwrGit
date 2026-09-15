import { beginGitDiagnostic } from "../git-diagnostics";
import { beginOwnership } from "./pipe-ownership.cjs";

/** Persist begin before entering execFileSync and end after return/throw.
 * The test journal's independent watchdog can inspect the outstanding call;
 * there is no ChildProcess handle or stream-event observation for this API. */
export function diagnoseSyncGit<T>(args: string[], cwd: string, run: (env: NodeJS.ProcessEnv) => T): T {
  const diagnostic = beginGitDiagnostic("system-git-sync", args, cwd);
  const ownership = beginOwnership(args, cwd, process.env, diagnostic?.id);
  ownership?.event("sync-call-begin");
  try {
    const result = run(ownership?.env ?? process.env);
    ownership?.event("sync-return");
    diagnostic?.settle("resolved");
    return result;
  } catch (error) {
    ownership?.event("sync-throw");
    diagnostic?.settle("rejected");
    throw error;
  }
}
