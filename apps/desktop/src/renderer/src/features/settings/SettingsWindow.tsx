import { useState } from "react";
import type {
  AppSettingsPatch,
  AppSettingsSnapshot,
  DiagnosticsSettings as DiagnosticsSettingsShape
} from "@pwrgit/shared";
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { ExperimentalSettings } from "./ExperimentalSettings";
import { GeneralSettings } from "./GeneralSettings";
import { ProfilesSettings } from "./ProfilesSettings";
import { useAppSettings, type AppSettingsState } from "./useAppSettings";

export type SettingsSection =
  | "general"
  | "profiles"
  | "experimental"
  | "diagnostics";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "general", label: "General" },
  { id: "profiles", label: "Profiles" },
  { id: "experimental", label: "Experimental" },
  { id: "diagnostics", label: "Memory / CPU" }
];

/**
 * The Settings window (boots on the `#settings` hash route). PwrAgnt's
 * SettingsScreen shell: left section nav with the brand masthead, content
 * pane with a breadcrumb titlebar on the right.
 */
export function SettingsWindow() {
  const settings = useAppSettings();
  const [section, setSection] = useState<SettingsSection>("general");
  const activeLabel =
    SECTIONS.find((entry) => entry.id === section)?.label ?? "Settings";

  return (
    <section className="settings-screen" aria-label="Settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <header className="settings-nav__masthead">
          <p className="settings-nav__brand">
            Pwr<span className="settings-nav__brand-accent">Git</span>
          </p>
        </header>
        <p className="settings-nav__group-label">Settings</p>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            aria-current={section === item.id ? "page" : undefined}
            className={`settings-nav__button${section === item.id ? " is-active" : ""}`}
            type="button"
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="settings-main">
        <header className="settings-titlebar">
          <span className="settings-titlebar__eyebrow">Settings</span>
          <span aria-hidden="true" className="settings-titlebar__separator">
            ›
          </span>
          <span className="settings-titlebar__current">{activeLabel}</span>
        </header>

        <div className="settings-content">
          <SettingsSectionBody section={section} settings={settings} />
          {settings.error !== null && (
            <p className="settings-field__error" role="alert">
              {settings.error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function SettingsSectionBody(props: {
  section: SettingsSection;
  settings: AppSettingsState;
}) {
  const { settings } = props;

  if (props.section === "profiles") {
    return <ProfilesSettings />;
  }

  // The remaining panes render from the snapshot.
  const snapshot: AppSettingsSnapshot | null = settings.snapshot;
  if (snapshot === null) {
    return (
      <p className="settings-empty">
        {settings.loading ? "Loading settings…" : "Settings are unavailable."}
      </p>
    );
  }

  const update = (patch: AppSettingsPatch): void => {
    void settings.update(patch);
  };
  const updateDiagnostics = (
    patch: Partial<DiagnosticsSettingsShape>
  ): void => {
    update({ diagnostics: patch });
  };

  if (props.section === "general") {
    return (
      <GeneralSettings
        saving={settings.saving}
        snapshot={snapshot}
        onDeveloperModeChange={(enabled) => {
          update({ general: { developerMode: enabled } });
        }}
      />
    );
  }

  if (props.section === "experimental") {
    return (
      <ExperimentalSettings
        saving={settings.saving}
        snapshot={snapshot}
        onLineageAllBranchesChange={(enabled) => {
          update({ experimental: { lineageAllBranches: enabled } });
        }}
      />
    );
  }

  return (
    <DiagnosticsSettings
      saving={settings.saving}
      snapshot={snapshot}
      onHeapMonitorEnabledChange={(enabled) => {
        updateDiagnostics({ heapMonitorEnabled: enabled });
      }}
      onHotCpuEnabledChange={(enabled) => {
        updateDiagnostics({ hotCpuProfilingEnabled: enabled });
      }}
      onHotCpuStartDelayChange={(delayMs) => {
        updateDiagnostics({ hotCpuProfilingStartDelayMs: delayMs });
      }}
      onHotCpuTriggerModeChange={(mode) => {
        updateDiagnostics({ hotCpuProfilingTriggerMode: mode });
      }}
      onHotCpuCaptureHeapSnapshotChange={(enabled) => {
        updateDiagnostics({ hotCpuProfilingCaptureHeapSnapshot: enabled });
      }}
      onHotCpuHeapSnapshotLimitChange={(limit) => {
        updateDiagnostics({ hotCpuProfilingHeapSnapshotLimit: limit });
      }}
      onStartupCpuEnabledChange={(enabled) => {
        updateDiagnostics({ startupCpuProfilingEnabled: enabled });
      }}
    />
  );
}
