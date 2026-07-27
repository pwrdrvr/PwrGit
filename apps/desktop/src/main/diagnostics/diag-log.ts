/** Minimal tagged console logger for diagnostics (PwrAgnt has a full main
 *  logger; PwrGit's is still landing — this keeps diagnostics self-contained
 *  and swappable for it later). */
export type DiagLogger = Pick<Console, "info" | "warn" | "error">;

export function getDiagLogger(tag: string): DiagLogger {
  return {
    info: (...args: unknown[]) => console.info(`[${tag}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[${tag}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${tag}]`, ...args)
  };
}
