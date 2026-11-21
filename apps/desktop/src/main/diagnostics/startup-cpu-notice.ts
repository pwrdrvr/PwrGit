import { ok, type StartupCpuProfileCapturedEvent } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";

/** index.ts broadcasts each to every window. */
type Broadcast = {
  captured: (event: StartupCpuProfileCapturedEvent) => void;
  dismissed: (sessionId: string) => void;
};

/**
 * Holds this launch's startup capture until someone dismisses its notice.
 *
 * The capture usually finishes a few seconds after the first window loads,
 * but a slow renderer (hard timeout) can finish it before that window has
 * subscribed to anything, and a broadcast then reaches nobody. So completion
 * is both broadcast to the windows already listening and kept here for any
 * window that mounts later; the renderer de-duplicates by session.
 */
export class StartupCpuProfileNotice {
  private pending: StartupCpuProfileCapturedEvent | null = null;

  constructor(private readonly broadcast: Broadcast) {}

  publish(event: StartupCpuProfileCapturedEvent): void {
    this.pending = event;
    this.broadcast.captured(event);
  }

  read(): StartupCpuProfileCapturedEvent | null {
    return this.pending;
  }

  dismiss(sessionId: string): void {
    if (this.pending?.sessionId !== sessionId) return;
    this.pending = null;
    this.broadcast.dismissed(sessionId);
  }

  register(bus: CommandBus): void {
    bus.register("diagnostics:readStartupCpuProfile", () => ok(this.read()));
    bus.register("diagnostics:dismissStartupCpuProfile", (req) => {
      if (typeof req?.sessionId === "string") this.dismiss(req.sessionId);
      return ok(null);
    });
  }
}
