// Startup and hot-CPU sessions address the same V8 profiler. Separate Node
// inspector connections must not start/stop each other's recording.
let owned = false;

export function isMainCpuProfilerOwned(): boolean {
  return owned;
}

export function acquireMainCpuProfiler(): () => void {
  if (owned) throw new Error("main CPU profiler is already owned");
  owned = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owned = false;
  };
}
