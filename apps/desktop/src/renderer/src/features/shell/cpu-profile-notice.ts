import {
  buildHotCpuProfileHandoffMessage,
  buildStartupCpuProfileHandoffMessage,
  formatHotCpuProfileTrigger,
  summarizeStartupCpuProfile,
  type HotCpuProfileCapturedEvent,
  type StartupCpuProfileCapturedEvent
} from "@pwrgit/shared";
import type { Toast } from "../../lib/toast";

export function cpuProfileNotice(event: HotCpuProfileCapturedEvent): Omit<Toast, "id" | "tone"> {
  return {
    key: `hot-cpu-profile:${event.profilePath}`,
    title: `${event.target === "main" ? "Main" : "Renderer"} CPU profile captured`,
    message: `${formatHotCpuProfileTrigger(event)} saved ${event.profileFilename}.`,
    facts: [
      { label: "Source", value: `Local app${event.sourceHostname ? ` on ${event.sourceHostname}` : ""}` },
      { label: "Captured", value: new Date(event.capturedAt).toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short"
      }) },
      { label: "Session", value: event.sessionDirectoryName }
    ],
    sticky: true,
    dismissGroup: { key: "hot-cpu-profile", label: "CPU profile notices" },
    copyText: buildHotCpuProfileHandoffMessage(event)
  };
}

export function startupCpuProfileNoticeKey(sessionId: string): string {
  return `startup-cpu-profile:${sessionId}`;
}

/**
 * A finished startup capture. Its own title, group and wording: nothing
 * triggered it and nothing was hot, so it must not read as a hot CPU capture
 * or page alongside them.
 */
export function startupCpuProfileNotice(
  event: StartupCpuProfileCapturedEvent,
  onDismiss: () => void
): Omit<Toast, "id" | "tone"> {
  const profiles = event.artifacts.filter((artifact) => artifact.kind === "main-profile" || artifact.kind === "renderer-profile").length;
  return {
    key: startupCpuProfileNoticeKey(event.sessionId),
    title: event.status === "completed"
      ? "Startup CPU profile saved"
      : event.status === "partial" ? "Startup CPU profile partly saved" : "Startup CPU profile not saved",
    message: summarizeStartupCpuProfile(event),
    facts: [
      { label: "Session", value: event.sessionDirectoryName },
      { label: "Files", value: `${profiles} of 2 profiles · ${event.artifacts.length} files` },
      { label: "Armed by", value: event.armedBy === "env" ? "PWRGIT_STARTUP_CPU_PROFILING" : "Settings · this launch only" }
    ],
    sticky: true,
    dismissGroup: { key: "startup-cpu-profile", label: "startup profile notices" },
    copyText: buildStartupCpuProfileHandoffMessage(event),
    onDismiss
  };
}
