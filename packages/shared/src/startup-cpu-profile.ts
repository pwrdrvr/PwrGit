import type { AppIdentity } from "./protocol";

/** One file the startup capture actually left in its session directory. */
export type StartupCpuProfileArtifact = {
  kind: "main-profile" | "renderer-profile" | "heap-snapshot" | "manifest" | "events";
  filename: string;
  path: string;
};

/**
 * A finished startup capture (main + first window, from launch until shortly
 * after first paint). Deliberately its own shape, not a
 * `HotCpuProfileCapturedEvent`: nothing triggered it, and it names two
 * profiles, not one.
 */
export type StartupCpuProfileCapturedEvent = {
  sessionId: string;
  sessionDirectory: string;
  sessionDirectoryName: string;
  /** completed: both profiles. partial: one. failed: neither. */
  status: "completed" | "partial" | "failed";
  /** Why the capture window closed: `post-load-elapsed`, `hard-timeout`. */
  reason: string;
  /** Settings arms one launch; the env var profiles every launch. */
  armedBy: "settings" | "env";
  startedAt: string;
  completedAt: string;
  /** Files on disk when the session closed, in a fixed order. */
  artifacts: StartupCpuProfileArtifact[];
  /** Expected profiles that were not written. */
  missing: Array<"main-profile" | "renderer-profile">;
  sourceHostname?: string;
  appIdentity?: AppIdentity;
};

const ARTIFACT_LABELS: Record<StartupCpuProfileArtifact["kind"], string> = {
  "main-profile": "Main CPU profile",
  "renderer-profile": "Renderer CPU profile",
  "heap-snapshot": "Heap snapshot",
  manifest: "Session manifest",
  events: "Events log"
};

const MISSING_LABELS = {
  "main-profile": "main.cpuprofile",
  "renderer-profile": "renderer.cpuprofile"
} as const;

/** One line for the notice body: what was saved, and what was not. */
export function summarizeStartupCpuProfile(event: StartupCpuProfileCapturedEvent): string {
  const profiles = event.artifacts
    .filter((artifact) => artifact.kind === "main-profile" || artifact.kind === "renderer-profile")
    .map((artifact) => artifact.filename);
  const saved = profiles.length === 0 ? "No CPU profile was saved" : `Saved ${profiles.join(" and ")}`;
  const missing = event.missing.length === 0
    ? ""
    : `; ${event.missing.map((kind) => MISSING_LABELS[kind]).join(" and ")} missing`;
  return `${saved}${missing}.`;
}

export function buildStartupCpuProfileHandoffMessage(event: StartupCpuProfileCapturedEvent): string {
  return [
    `PwrGit captured a startup CPU profile (${event.status}).`,
    `Source: Local app${event.sourceHostname ? ` on ${event.sourceHostname}` : ""}`,
    `Armed by: ${event.armedBy === "env" ? "PWRGIT_STARTUP_CPU_PROFILING" : "Settings (this launch only)"}`,
    `Started at: ${event.startedAt}`,
    `Completed at: ${event.completedAt} (${event.reason})`,
    ...(event.appIdentity ? [event.appIdentity.diagnosticsText] : []),
    `Session basename: ${event.sessionDirectoryName}`,
    `Session directory path: ${event.sessionDirectory}`,
    ...event.artifacts.map((artifact) => `${ARTIFACT_LABELS[artifact.kind]}: ${artifact.path}`),
    ...event.missing.map((kind) => `Not captured: ${MISSING_LABELS[kind]} (see events.ndjson)`),
    "Open each .cpuprofile in Chrome DevTools Performance. This is a startup capture, not a hot CPU trigger; it has no Chromium trace."
  ].join("\n");
}
