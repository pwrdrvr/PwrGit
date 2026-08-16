import { useState } from "react";
import type {
  AppSettingsPatch,
  AppSettingsSnapshot,
  DiagnosticsSettings as DiagnosticsSettingsShape
} from "@pwrgit/shared";
import { AuxiliaryTitleBar } from "../chrome/AuxiliaryTitleBar";
import { AboutSettings } from "./AboutSettings";
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { ExperimentalSettings } from "./ExperimentalSettings";
import { GeneralSettings } from "./GeneralSettings";
import { ProfilesSettings } from "./ProfilesSettings";
import { UpdatesSettings } from "./UpdatesSettings";
import { useAppSettings, type AppSettingsState } from "./useAppSettings";

export type SettingsSection =
  | "general"
  | "updates"
  | "profiles"
  | "experimental"
  | "diagnostics"
  | "about";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "general", label: "General" },
  { id: "updates", label: "Updates" },
  { id: "profiles", label: "Profiles" },
  { id: "experimental", label: "Experimental" },
  { id: "diagnostics", label: "Memory / CPU" },
  { id: "about", label: "About" }
];

/**
 * The Settings window (boots on the `#settings` hash route). A shared
 * auxiliary title strip sits above the section nav and content pane so
 * Windows caption controls and macOS traffic lights occupy the same chrome as
 * every helper window.
 */
export function SettingsWindow() {
  const settings = useAppSettings();
  const [section, setSection] = useState<SettingsSection>("general");
  const activeLabel =
    SECTIONS.find((entry) => entry.id === section)?.label ?? "Settings";

  return (
    <section className="settings-screen" aria-label="Settings">
      <AuxiliaryTitleBar section="Settings" title={activeLabel} />
      <div className="settings-screen__body">
        <nav className="settings-nav" aria-label="Settings sections">
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
          <div className="settings-content">
            <SettingsSectionBody section={section} settings={settings} />
            {settings.error !== null && (
              <p className="settings-field__error" role="alert">
                {settings.error}
              </p>
            )}
          </div>
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

  if (props.section === "about") {
    return <AboutSettings />;
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
        onSidebarTextSizeChange={(sidebarTextSize) => {
          update({ general: { sidebarTextSize } });
        }}
        onSidebarDensityChange={(sidebarDensity) => {
          update({ general: { sidebarDensity } });
        }}
      />
    );
  }

  if (props.section === "updates") {
    return (
      <UpdatesSettings
        saving={settings.saving}
        snapshot={snapshot}
        onSelectionChange={(next) => {
          update({ updates: next });
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
