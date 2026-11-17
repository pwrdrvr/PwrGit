import type { AppIdentity, HotCpuTriggerMode } from "./protocol";

export type HotCpuProfileHeapSnapshotArtifact = {
  filename: string;
  path: string;
  phase: string;
};

export type HotCpuProfileCapturedEvent = {
  target: "main" | "renderer";
  sourceHostname?: string;
  appIdentity?: AppIdentity;
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

// PwrAgnt's trigger and handoff format, using PwrGit's existing app identity.
function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatHotCpuProfileTrigger(event: HotCpuProfileCapturedEvent): string {
  const mode = { spike: "Spike", sustained: "Sustained", slowburn: "Slowburn" }[event.triggerMode];
  const samples = event.triggerConsecutiveSamples === 1 ? "1 sample" : `${event.triggerConsecutiveSamples} consecutive samples`;
  return `${mode} (${samples} >= ${formatPercent(event.triggerThresholdPercent)}%; trigger sample ${formatPercent(event.triggerCpuPercent)}%)`;
}

export function buildHotCpuProfileHandoffMessage(event: HotCpuProfileCapturedEvent): string {
  return [
    `PwrGit captured a ${event.target} CPU profile.`,
    `Source: Local app${event.sourceHostname ? ` on ${event.sourceHostname}` : ""}`,
    `Captured at: ${event.capturedAt}`,
    ...(event.appIdentity ? [event.appIdentity.diagnosticsText] : []),
    `Trigger: ${formatHotCpuProfileTrigger(event)}`,
    `Session basename: ${event.sessionDirectoryName}`,
    `Session directory path: ${event.sessionDirectory}`,
    `CPU profile basename: ${event.profileFilename}`,
    `CPU profile path: ${event.profilePath}`,
    ...(event.heapSnapshotArtifacts.length > 0 ? [
      `Heap snapshots captured: ${event.heapSnapshotArtifacts.length}`,
      ...event.heapSnapshotArtifacts.flatMap((artifact) => [
        `Heap snapshot ${artifact.phase} basename: ${artifact.filename}`,
        `Heap snapshot ${artifact.phase} path: ${artifact.path}`
      ])
    ] : []),
    "Open the .cpuprofile in Chrome DevTools Performance, or inspect the full session directory for samples, events, and optional heap snapshots."
  ].join("\n");
}
