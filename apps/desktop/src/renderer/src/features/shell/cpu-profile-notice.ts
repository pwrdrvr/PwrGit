import {
  buildHotCpuProfileHandoffMessage,
  formatHotCpuProfileTrigger,
  type HotCpuProfileCapturedEvent
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import type { Toast } from "../../lib/toast";

export function cpuProfileNotice(event: HotCpuProfileCapturedEvent): Omit<Toast, "id" | "tone"> {
  return {
    key: `hot-cpu-profile:${event.profilePath}`,
    title: `${event.target === "main" ? "Main" : "Renderer"} CPU profile captured`,
    message: `${formatHotCpuProfileTrigger(event)} Saved ${event.profileFilename}.`,
    detail: `Captured ${new Date(event.capturedAt).toLocaleString()}\nSession: ${event.sessionDirectoryName}`,
    sticky: true,
    dismissGroup: { key: "hot-cpu-profile", label: "CPU profile notices" },
    layout: "stacked",
    showCopyAction: true,
    copyLabel: "Copy profile details",
    copyText: buildHotCpuProfileHandoffMessage(event),
    action: {
      label: "Open folder",
      dismiss: false,
      run: () => { void dispatch("shell:revealPath", { path: event.profilePath }); }
    }
  };
}
