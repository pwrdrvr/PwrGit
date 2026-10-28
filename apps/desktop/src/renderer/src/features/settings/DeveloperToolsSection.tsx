import { useEffect, useState } from "react";
import type { AppProcessIds } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { dispatchOrThrow } from "../../lib/pwrgit";
import {
  currentPlatform,
  isMacPlatform,
  shortcutLabel
} from "../../lib/platform";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

type Feedback = { kind: "status" | "error"; message: string };

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function readProcessIds(): Promise<AppProcessIds> {
  return dispatchOrThrow("app:readProcessIds", undefined);
}

/**
 * Troubleshooting → Chrome DevTools (PwrAgnt's card of the same name).
 *
 * Process IDs are read when the card mounts and again on Copy: renderers come
 * and go as windows open, so the copy is re-read rather than trusting what the
 * card showed a minute ago.
 */
export function DeveloperToolsSection(props: {
  saving: boolean;
  developerMode: boolean;
  onDeveloperModeChange: (enabled: boolean) => void;
  /** Explicit only in deterministic platform component tests. */
  platform?: string;
}) {
  const [processIds, setProcessIds] = useState<AppProcessIds | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const platform = props.platform ?? currentPlatform();
  const developerShortcuts = [
    shortcutLabel({ key: "R" }, platform),
    shortcutLabel({ key: "R", shift: true }, platform),
    shortcutLabel(
      isMacPlatform(platform)
        ? { key: "I", alt: true }
        : { key: "I", shift: true },
      platform
    )
  ].join(", ");

  useEffect(() => {
    let canceled = false;
    readProcessIds()
      .then((value) => {
        if (!canceled) setProcessIds(value);
      })
      .catch((cause: unknown) => {
        if (!canceled) setReadError(errorText(cause));
      });
    return () => {
      canceled = true;
    };
  }, []);

  const copyProcessIds = async (): Promise<void> => {
    try {
      const fresh = await readProcessIds();
      setProcessIds(fresh);
      setReadError(null);
      await copyText(fresh.diagnosticsText);
      setFeedback({ kind: "status", message: "Process IDs copied." });
    } catch (cause) {
      setFeedback({
        kind: "error",
        message: `Couldn’t copy process IDs: ${errorText(cause)}`
      });
    }
  };

  const line = processIds?.line ?? "";

  return (
    <SettingsSection
      eyebrow="Troubleshooting"
      title="Chrome DevTools"
      description="Electron development helpers stay hidden unless you opt in."
      chip={props.developerMode ? "On" : "Off"}
      chipKind={props.developerMode ? "ok" : "default"}
    >
      <div className="settings-fields">
        <SettingsField
          label="Developer Mode"
          sub="Expose Reload, Force Reload, and Developer Tools in the View menu."
          help={`Also enables their shortcuts (${developerShortcuts}). Takes effect immediately in every window.`}
          control={
            <SettingsSwitch
              checked={props.developerMode}
              disabled={props.saving}
              label="Developer Mode"
              onChange={props.onDeveloperModeChange}
            />
          }
        />
        <SettingsField
          label="Process IDs"
          sub="Attach a debugger or profiler to the right process when several Electron apps are running."
          help={
            feedback === null ? undefined : (
              <span
                className={
                  feedback.kind === "error"
                    ? "about-feedback about-feedback--error"
                    : "about-feedback"
                }
                role={feedback.kind === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {feedback.message}
              </span>
            )
          }
          control={
            <div className="about-resource-actions">
              {line !== "" ? (
                <code className="settings-field__value">{line}</code>
              ) : (
                <span className="settings-field__value settings-field__value--absent">
                  {processIds === null && readError === null
                    ? "Loading…"
                    : "Unavailable"}
                </span>
              )}
              <button
                className="settings-button"
                type="button"
                onClick={() => {
                  void copyProcessIds();
                }}
              >
                Copy process IDs
              </button>
            </div>
          }
        />
      </div>
    </SettingsSection>
  );
}
