import { Session } from "node:inspector/promises";
import type { HotCpuTarget } from "./hot-cpu-profiler";
import { acquireMainCpuProfiler, isMainCpuProfilerOwned } from "./main-cpu-profiler-ownership";

export function createMainProcessHotCpuTarget(): HotCpuTarget {
  let session: Session | null = null;
  let release: (() => void) | null = null;
  return {
    debugger: {
      attach: () => {
        const acquired = acquireMainCpuProfiler();
        try {
          const next = new Session();
          next.connect();
          session = next;
          release = acquired;
        } catch (error) {
          acquired();
          throw error;
        }
      },
      detach: () => {
        try { session?.disconnect(); }
        finally { session = null; release?.(); release = null; }
      },
      isAttached: isMainCpuProfilerOwned,
      sendCommand: async (method, params) => {
        if (session === null) throw new Error("main inspector is not attached");
        return session.post(method, params);
      },
      // In-process inspector sessions have no remote peer to detach them.
      on: () => {}, off: () => {}
    },
    getOSProcessId: () => process.pid,
    readHeapUsage: () => {
      const { heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
      return { heapUsed, heapTotal, external, arrayBuffers };
    }
    // Automatic main heap snapshots would block every window. The separate
    // opt-in heap monitor remains available; hot CPU records cheap counters.
  };
}
