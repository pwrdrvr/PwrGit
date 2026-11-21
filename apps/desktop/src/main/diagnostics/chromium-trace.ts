import fs from "node:fs/promises";
import type { ContentTracing, TraceConfig } from "electron";

const TRACE_CONFIG: TraceConfig = {
  recording_mode: "record-continuously",
  trace_buffer_size_in_kb: 32 * 1024,
  enable_argument_filter: true,
  included_categories: ["devtools.timeline", "blink.user_timing", "cc", "viz"],
  excluded_categories: ["*"]
};

type TraceBackend = Pick<ContentTracing, "startRecording" | "stopRecording">;

export type ChromiumTraceCapture =
  | { status: "written"; recordingStartedAtMs: number; recordingStoppedAtMs: number }
  | { status: "skipped"; reason: "not-recording" | "trigger-predates-recording" };

/** Chromium allows a single trace for the app, even with multiple profile
 * windows. An overlapping CPU trigger cannot claim the next trace's history. */
export class ChromiumTrace {
  private queue: Promise<unknown> = Promise.resolve();
  private startedAtMs: number | null = null;

  constructor(
    private readonly backend: () => TraceBackend,
    private readonly warn: (message: string, error: unknown) => void,
    private readonly now: () => number = Date.now
  ) {}

  setArmed(armed: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (armed) {
        await this.start();
      } else if (this.startedAtMs !== null) {
        try {
          const discarded = await this.backend().stopRecording();
          this.startedAtMs = null;
          await fs.rm(discarded, { force: true });
        } catch (error) {
          this.warn("Could not discard Chromium trace", error);
        }
      }
    });
  }

  capture(filePath: string, triggerAtMs: number, rearm: () => boolean): Promise<ChromiumTraceCapture> {
    return this.enqueue(async () => {
      const recordingStartedAtMs = this.startedAtMs;
      if (recordingStartedAtMs === null) return { status: "skipped", reason: "not-recording" };
      if (triggerAtMs <= recordingStartedAtMs) {
        return { status: "skipped", reason: "trigger-predates-recording" };
      }
      const recordingStoppedAtMs = this.now();
      try {
        await this.backend().stopRecording(filePath);
        this.startedAtMs = null;
      } catch (error) {
        await fs.rm(filePath, { force: true }).catch((cleanupError) => {
          this.warn("Could not remove partial Chromium trace", cleanupError);
        });
        throw error;
      } finally {
        if (rearm()) await this.start();
      }
      return { status: "written", recordingStartedAtMs, recordingStoppedAtMs };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async start(): Promise<void> {
    if (this.startedAtMs !== null) return;
    try {
      await this.backend().startRecording(TRACE_CONFIG);
      this.startedAtMs = this.now();
    } catch (error) {
      this.warn("Could not arm Chromium trace", error);
    }
  }
}
