import type { HotCpuTriggerMode } from "./protocol";

export type HotCpuProfileHeapSnapshotArtifact = {
  filename: string;
  path: string;
  phase: string;
};

export type HotCpuProfileCapturedEvent = {
  target: "main" | "renderer";
  capturedAt: string;
  heapSnapshotArtifacts: HotCpuProfileHeapSnapshotArtifact[];
  profileFilename: string;
  profilePath: string;
  sessionDirectory: string;
  sessionDirectoryName: string;
  triggerConsecutiveSamples: number;
  triggerCpuPercent: number;
  triggerMode: HotCpuTriggerMode;
  triggerThresholdPercent: number;
};

export function formatHotCpuProfileTrigger(event: HotCpuProfileCapturedEvent): string {
  const mode = { spike: "Spike", sustained: "Sustained", slowburn: "Slow burn" }[event.triggerMode];
  const samples = event.triggerConsecutiveSamples === 1 ? "1 sample" : `${event.triggerConsecutiveSamples} consecutive samples`;
  return `${mode}: ${samples} at or above ${event.triggerThresholdPercent}% CPU (trigger ${event.triggerCpuPercent.toFixed(1)}%).`;
}

export function buildHotCpuProfileHandoffMessage(event: HotCpuProfileCapturedEvent): string {
  return [
    `PwrGit captured a ${event.target} CPU profile.`,
    `Captured at: ${event.capturedAt}`,
    `Trigger: ${formatHotCpuProfileTrigger(event)}`,
    `Session directory: ${event.sessionDirectory}`,
    `CPU profile: ${event.profilePath}`,
    ...event.heapSnapshotArtifacts.map((artifact) => `Heap snapshot (${artifact.phase}): ${artifact.path}`),
    "Open the .cpuprofile in Chrome DevTools, or inspect the session directory for samples and events."
  ].join("\n");
}
