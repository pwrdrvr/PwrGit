import { RESOURCE_USAGE_RECORDING_MS, type DiagnosticsSettings } from "@pwrgit/shared";

type ResourceUsageSettings = Pick<DiagnosticsSettings, "resourceUsageEnabled" | "resourceUsageExpiresAt">;

export type ResourceUsageWindow =
  | { state: "off" }
  | { state: "recording"; expiresAtMs: number }
  | { state: "expired" }
  /** On with no readable expiry: a setting written before recordings were
   *  bounded, or a hand-edited file. Granted a fresh window from now. */
  | { state: "unbounded" };

/** Whether resource recording should run at `nowMs`, by wall clock. */
export function resolveResourceUsageWindow(settings: ResourceUsageSettings, nowMs: number): ResourceUsageWindow {
  if (settings.resourceUsageEnabled !== true) return { state: "off" };
  const expiresAtMs = typeof settings.resourceUsageExpiresAt === "string"
    ? Date.parse(settings.resourceUsageExpiresAt)
    : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) return { state: "unbounded" };
  if (nowMs >= expiresAtMs) return { state: "expired" };
  // A stored expiry further out than one recording (clock moved back, edited
  // file) must not become an open-ended recording.
  return { state: "recording", expiresAtMs: Math.min(expiresAtMs, nowMs + RESOURCE_USAGE_RECORDING_MS) };
}

export function resourceUsageExpiry(nowMs: number): string {
  return new Date(nowMs + RESOURCE_USAGE_RECORDING_MS).toISOString();
}

/**
 * The stored pair after a Settings write. Turning the switch on starts a new
 * 24-hour window; leaving it on keeps the original expiry (a repeated `true`
 * must not extend it); turning it off clears the expiry.
 */
export function nextResourceUsageSettings(
  stored: Partial<ResourceUsageSettings>,
  requested: boolean | undefined,
  nowMs: number
): Partial<ResourceUsageSettings> {
  if (requested === undefined) return {};
  if (!requested) return { resourceUsageEnabled: false, resourceUsageExpiresAt: null };
  const current = resolveResourceUsageWindow({
    resourceUsageEnabled: stored.resourceUsageEnabled === true,
    resourceUsageExpiresAt: stored.resourceUsageExpiresAt ?? null
  }, nowMs);
  return {
    resourceUsageEnabled: true,
    resourceUsageExpiresAt: current.state === "recording"
      ? new Date(current.expiresAtMs).toISOString()
      : resourceUsageExpiry(nowMs)
  };
}
