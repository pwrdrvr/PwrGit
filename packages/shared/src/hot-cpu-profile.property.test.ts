import fc from "fast-check";
import { expect, it } from "vitest";
import { buildHotCpuProfileHandoffMessage, type HotCpuProfileCapturedEvent } from "./hot-cpu-profile";

it("copies every diagnostic identity and artifact field for either process and every heap snapshot", () => {
  fc.assert(fc.property(fc.constantFrom("main" as const, "renderer" as const), fc.array(fc.constantFrom("start", "mid", "stop"), { maxLength: 3 }), (target, phases) => {
    const event: HotCpuProfileCapturedEvent = {
      target, sourceHostname: "cpu-lab.example", capturedAt: "2026-11-16T12:00:00.000Z",
      appIdentity: { name: "PwrGit", version: "1.2.3", release: { train: "stable", channel: "latest" }, buildType: "packaged", platform: { name: "macOS", version: "26.0", arch: "arm64" }, electronVersion: "44.10.2", diagnosticsText: "PwrGit 1.2.3\nBuild: Packaged\nPlatform: macOS 26.0 (arm64)\nElectron: 44.10.2" },
      sessionDirectory: "/demo/diagnostics/hot-cpu-123", sessionDirectoryName: "hot-cpu-123",
      profilePath: `/demo/diagnostics/hot-cpu-123/${target}-0001.cpuprofile`, profileFilename: `${target}-0001.cpuprofile`,
      triggerMode: "spike", triggerConsecutiveSamples: 1, triggerCpuPercent: 67.9, triggerThresholdPercent: 50,
      heapSnapshotArtifacts: phases.map((phase, index) => ({ phase, filename: `heap-${index}.heapsnapshot`, path: `/demo/diagnostics/hot-cpu-123/heap-${index}.heapsnapshot` }))
    };
    const text = buildHotCpuProfileHandoffMessage(event);
    for (const line of [
      `PwrGit captured a ${target} CPU profile.`, "Source: Local app on cpu-lab.example", `Captured at: ${event.capturedAt}`,
      event.appIdentity!.diagnosticsText, "Trigger: Spike (1 sample >= 50%; trigger sample 67.9%)",
      `Session basename: ${event.sessionDirectoryName}`, `Session directory path: ${event.sessionDirectory}`,
      `CPU profile basename: ${event.profileFilename}`, `CPU profile path: ${event.profilePath}`,
      ...event.heapSnapshotArtifacts.flatMap((artifact) => [`Heap snapshot ${artifact.phase} basename: ${artifact.filename}`, `Heap snapshot ${artifact.phase} path: ${artifact.path}`])
    ]) expect(text).toContain(line);
    if (phases.length) expect(text).toContain(`Heap snapshots captured: ${phases.length}`);
  }));
});
