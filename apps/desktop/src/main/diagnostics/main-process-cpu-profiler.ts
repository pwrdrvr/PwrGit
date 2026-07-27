// Ported from PwrAgnt (diagnostics/main-process-cpu-profiler.ts): profiles the
// main process during startup via node:inspector and writes main.cpuprofile.
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import type { StartupCpuProfileSession } from "./startup-cpu-profile-session";
import { getDiagLogger, type DiagLogger } from "./diag-log";

type InspectorProfilerSession = {
  connect: () => void;
  disconnect: () => void;
  post: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};

function createInspectorProfilerSession(): InspectorProfilerSession {
  return new Session();
}

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MainProcessCpuProfiler {
  private readonly logger: DiagLogger;
  private readonly now: () => Date;
  private readonly profilerSession: InspectorProfilerSession;
  private readonly session: StartupCpuProfileSession;

  private connected = false;
  private profiling = false;
  private stopCompleted = false;

  constructor(options: {
    session: StartupCpuProfileSession;
    logger?: DiagLogger;
    now?: () => Date;
    profilerSession?: InspectorProfilerSession;
  }) {
    this.logger = options.logger ?? getDiagLogger("pwrgit:startup-cpu");
    this.now = options.now ?? (() => new Date());
    this.profilerSession =
      options.profilerSession ?? createInspectorProfilerSession();
    this.session = options.session;
  }

  async start(): Promise<boolean> {
    if (this.profiling) return true;

    try {
      this.profilerSession.connect();
      this.connected = true;
      await this.profilerSession.post("Profiler.enable");
      await this.profilerSession.post("Profiler.start");
      this.profiling = true;
      await this.session.appendEvent({
        source: "main",
        capturedAt: this.now().toISOString(),
        type: "profiler-started",
        detail: { filename: "main.cpuprofile" }
      });
      return true;
    } catch (error) {
      await this.session.appendEvent({
        source: "main",
        capturedAt: this.now().toISOString(),
        type: "profiler-start-failed",
        detail: { error: serializeError(error) }
      });
      this.logger.error("main startup CPU profiler failed to start", error);
      this.disconnect();
      return false;
    }
  }

  async stop(reason = "stopped"): Promise<boolean> {
    if (this.stopCompleted) return false;
    this.stopCompleted = true;

    if (!this.profiling) {
      this.disconnect();
      return false;
    }

    try {
      const result = (await this.profilerSession.post("Profiler.stop")) as {
        profile?: unknown;
      };
      await fs.writeFile(
        this.session.mainProfilePath,
        `${JSON.stringify(result.profile ?? {}, null, 2)}\n`,
        "utf8"
      );
      const capturedAt = this.now().toISOString();
      await this.session.markProfileCaptured("main", capturedAt);
      await this.session.appendEvent({
        source: "main",
        capturedAt,
        type: "profile-written",
        detail: { filename: "main.cpuprofile", reason }
      });
      return true;
    } catch (error) {
      await this.session.appendEvent({
        source: "main",
        capturedAt: this.now().toISOString(),
        type: "profiler-stop-failed",
        detail: { error: serializeError(error), reason }
      });
      this.logger.error("main startup CPU profiler failed to stop", error);
      return false;
    } finally {
      this.profiling = false;
      this.disconnect();
    }
  }

  private disconnect(): void {
    if (!this.connected) return;
    this.profilerSession.disconnect();
    this.connected = false;
  }
}
