import { logMain } from "../logs";

/** Tagged logger for diagnostics, routed through the main app log so heap /
 *  CPU profiling events show up in the Logs window (Help › Logs). */
export type DiagLogger = Pick<Console, "info" | "warn" | "error">;

export function getDiagLogger(tag: string): DiagLogger {
  return {
    info: (...args: unknown[]) => void logMain("info", tag, ...args),
    warn: (...args: unknown[]) => void logMain("warn", tag, ...args),
    error: (...args: unknown[]) => void logMain("error", tag, ...args)
  };
}
