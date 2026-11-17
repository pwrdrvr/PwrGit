import {
  buildHotCpuProfileHandoffMessage,
  formatHotCpuProfileTrigger,
  type HotCpuProfileCapturedEvent
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
