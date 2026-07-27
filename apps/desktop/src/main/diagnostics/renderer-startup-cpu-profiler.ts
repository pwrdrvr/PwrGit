// Ported from PwrAgnt (diagnostics/renderer-startup-cpu-profiler.ts): profiles
// the first window's renderer during startup over CDP and writes
// renderer.cpuprofile.
import fs from "node:fs/promises";
import type { StartupCpuProfileSession } from "./startup-cpu-profile-session";
import { getDiagLogger, type DiagLogger } from "./diag-log";

const CHROME_DEBUGGER_PROTOCOL_VERSION = "1.3";

type RendererDebugger = {
  attach: (version: string) => void;
  detach: () => void;
  isAttached: () => boolean;
  sendCommand: (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<unknown>;
  on: (event: "detach", listener: (event: unknown, reason: string) => void) => void;
  off?: (event: "detach", listener: (event: unknown, reason: string) => void) => void;
};

export type RendererStartupCpuTarget = {
  debugger: RendererDebugger;
  isDestroyed?: () => boolean;
};

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RendererStartupCpuProfiler {
  private readonly detachListener = (_event: unknown, reason: string) => {
    this.detachedReason = reason;
    void this.session.appendEvent({
      source: "renderer",
      capturedAt: this.now().toISOString(),
      type: "debugger-detached",
      detail: { reason }
    });
    this.logger.warn("renderer startup CPU profiler debugger detached", {
      reason,
      sessionDirectory: this.session.directoryPath
    });
  };

  private readonly logger: DiagLogger;
  private readonly now: () => Date;
  private readonly session: StartupCpuProfileSession;
  private readonly target: RendererStartupCpuTarget;

  private attachedByProfiler = false;
  private detachedReason?: string;
  private profiling = false;
  private stopCompleted = false;

  constructor(options: {
    target: RendererStartupCpuTarget;
    session: StartupCpuProfileSession;
    logger?: DiagLogger;
    now?: () => Date;
  }) {
    this.logger = options.logger ?? getDiagLogger("pwrgit:startup-cpu");
    this.now = options.now ?? (() => new Date());
    this.session = options.session;
    this.target = options.target;
  }

  async start(): Promise<boolean> {
    if (this.profiling) return true;

    if (this.target.debugger.isAttached()) {
      await this.session.appendEvent({
        source: "renderer",
        capturedAt: this.now().toISOString(),
        type: "profiler-start-skipped",
        detail: { reason: "debugger-already-attached" }
      });
      this.logger.warn(
        "renderer startup CPU profiler skipped because debugger is already attached"
      );
      return false;
    }

    try {
      this.target.debugger.attach(CHROME_DEBUGGER_PROTOCOL_VERSION);
      this.attachedByProfiler = true;
      this.target.debugger.on("detach", this.detachListener);
      await this.target.debugger.sendCommand("Profiler.enable");
      await this.target.debugger.sendCommand("Profiler.start");
      this.profiling = true;
      await this.session.appendEvent({
        source: "renderer",
        capturedAt: this.now().toISOString(),
        type: "profiler-started",
        detail: { filename: "renderer.cpuprofile" }
      });
      return true;
    } catch (error) {
      await this.session.appendEvent({
        source: "renderer",
        capturedAt: this.now().toISOString(),
        type: "profiler-start-failed",
        detail: { error: serializeError(error) }
      });
      this.logger.error("renderer startup CPU profiler failed to start", error);
      this.detachDebugger();
      return false;
    }
  }

  async stop(reason = "stopped"): Promise<boolean> {
    if (this.stopCompleted) return false;
    this.stopCompleted = true;

    if (!this.profiling || this.detachedReason) {
      this.detachDebugger();
      return false;
    }

    try {
      const result = (await this.target.debugger.sendCommand(
        "Profiler.stop"
      )) as { profile?: unknown };
      await fs.writeFile(
        this.session.rendererProfilePath,
        `${JSON.stringify(result.profile ?? {}, null, 2)}\n`,
        "utf8"
      );
      const capturedAt = this.now().toISOString();
      await this.session.markProfileCaptured("renderer", capturedAt);
      await this.session.appendEvent({
        source: "renderer",
        capturedAt,
        type: "profile-written",
        detail: { filename: "renderer.cpuprofile", reason }
      });
      return true;
    } catch (error) {
      await this.session.appendEvent({
        source: "renderer",
        capturedAt: this.now().toISOString(),
        type: "profiler-stop-failed",
        detail: { error: serializeError(error), reason }
      });
      this.logger.error("renderer startup CPU profiler failed to stop", error);
      return false;
    } finally {
      this.profiling = false;
      this.detachDebugger();
    }
  }

  private detachDebugger(): void {
    if (this.target.debugger.off) {
      this.target.debugger.off("detach", this.detachListener);
    }

    if (
      !this.attachedByProfiler ||
      !this.target.debugger.isAttached() ||
      this.isTargetDestroyed()
    ) {
      return;
    }

    this.target.debugger.detach();
    this.attachedByProfiler = false;
  }

  private isTargetDestroyed(): boolean {
    return Boolean(this.target.isDestroyed?.());
  }
}
