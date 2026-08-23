import type {
  AppearanceTheme,
  AppSettingsSnapshot,
  SidebarDensity,
  SidebarTextSize
} from "@pwrgit/shared";
import {
  currentPlatform,
  isMacPlatform,
  shortcutLabel
} from "../../lib/platform";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSegmented
} from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

/** The notch ladder, labelled. Values match `tokens.css`. */
const TEXT_SIZES: Array<{ value: SidebarTextSize; label: string; meta: string }> =
  [
    { value: "xs", label: "XS", meta: "11px" },
    { value: "sm", label: "S", meta: "12px" },
    { value: "md", label: "M", meta: "13px" },
    { value: "lg", label: "L", meta: "14px" },
    { value: "xl", label: "XL", meta: "15px" }
  ];

const DENSITIES: Array<{ value: SidebarDensity; label: string }> = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" }
];

const THEMES: Array<{ value: AppearanceTheme; label: string }> = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" }
];

/** General pane (PwrAgnt's GeneralSettings pattern, PwrGit-sized). */
export function GeneralSettings(props: {
  saving: boolean;
  snapshot: AppSettingsSnapshot;
  onThemeChange: (theme: AppearanceTheme) => void;
  onDeveloperModeChange: (enabled: boolean) => void;
  onSidebarTextSizeChange: (size: SidebarTextSize) => void;
  onSidebarDensityChange: (density: SidebarDensity) => void;
  /** Explicit only in deterministic platform component tests. */
  platform?: string;
}) {
  const developerMode = props.snapshot.general.developerMode;
  const theme = props.snapshot.general.theme;
  const textSize = props.snapshot.general.sidebarTextSize;
  const density = props.snapshot.general.sidebarDensity;
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

  return (
    <div className="settings-stack" aria-label="General settings">
      <SettingsPanelHead
        eyebrow="General"
        title="General settings"
        help="Defaults that apply across PwrGit windows unless a profile overrides them."
      />

      <SettingsSection
        eyebrow="Appearance"
        title="Color theme"
        description="Choose a fixed palette or follow the operating system."
        chip={
          theme === "system" ? "System" : theme === "light" ? "Light" : "Dark"
        }
        chipKind="default"
      >
        <div className="settings-fields">
          <SettingsField
            label="Theme"
            sub="Default for PwrGit windows and native window chrome. Profiles can choose their own fixed palette."
            help="System follows macOS or Windows appearance changes while PwrGit is running; inheriting profiles follow it too."
            control={
              <SettingsSegmented
                aria-label="Color theme"
                disabled={props.saving}
                options={THEMES}
                value={theme}
                onChange={props.onThemeChange}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Appearance"
        title="Sidebar"
        description="Two independent axes: how big the names are, and how tightly the rows pack."
        chip={density === "compact" ? "Compact" : textSize.toUpperCase()}
        chipKind="default"
      >
        <div className="settings-fields">
          <SettingsField
            label="Text size"
            sub="Repo names in the left bar; worktree branches follow one step down."
            help="Counts, tags, and section labels hold still on purpose, so a larger size reads as bigger names rather than as zooming the whole app."
            control={
              <SettingsSegmented
                aria-label="Sidebar text size"
                disabled={props.saving}
                options={TEXT_SIZES}
                value={textSize}
                onChange={props.onSidebarTextSizeChange}
              />
            }
          />
          <SettingsField
            label="Density"
            sub="Row padding and the gaps between repos."
            help="Independent of text size — Compact with a larger text size is a valid combination."
            control={
              <SettingsSegmented
                aria-label="Sidebar density"
                disabled={props.saving}
                options={DENSITIES}
                value={density}
                onChange={props.onSidebarDensityChange}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="General"
        title="Developer mode"
        description="Electron development helpers stay hidden unless you opt in."
        chip={developerMode ? "On" : "Off"}
        chipKind={developerMode ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Developer Mode"
            sub="Expose Reload, Force Reload, and Developer Tools in the View menu."
            help={`Also enables their shortcuts (${developerShortcuts}). Takes effect immediately in every window.`}
            control={
              <SettingsSwitch
                checked={developerMode}
                disabled={props.saving}
                label="Developer Mode"
                onChange={props.onDeveloperModeChange}
              />
            }
          />
        </div>
      </SettingsSection>
    </div>
  );
}
