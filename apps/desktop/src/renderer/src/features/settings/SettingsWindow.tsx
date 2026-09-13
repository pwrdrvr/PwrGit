import { Fragment, useState } from "react";
import {
  FORGE_KINDS,
  forgeLabel,
  type AppSettingsPatch,
  type AppSettingsSnapshot,
  type DiagnosticsSettings as DiagnosticsSettingsShape,
  type ForgeKind,
  type ForgeStatus
} from "@pwrgit/shared";
import { AuxiliaryTitleBar } from "../chrome/AuxiliaryTitleBar";
import { AboutSettings } from "./AboutSettings";
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { ExperimentalSettings } from "./ExperimentalSettings";
import { GeneralSettings } from "./GeneralSettings";
import { ProfilesSettings } from "./ProfilesSettings";
import { ForgesSettings } from "./ForgesSettings";
import { UpdatesSettings } from "./UpdatesSettings";
import { LocalAgentsSettings } from "./LocalAgentsSettings";
import {
  FORGE_STATE_NAV,
  forgeProductState,
  forgeStateSentence,
  type ForgeNavDot
} from "./ForgeProductSection";
import type { SettingsFocusRequest } from "./SettingsLayout";
import { useForgeStatuses } from "./useForgeStatuses";
import { useAppSettings, type AppSettingsState } from "./useAppSettings";

export type SettingsSection =
  | "general"
  | "updates"
  | "profiles"
  | "experimental"
  | "diagnostics"
  | "forges"
  | "agents"
  | "about";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "general", label: "General" },
  { id: "updates", label: "Updates" },
  { id: "profiles", label: "Profiles" },
  { id: "forges", label: "Forges" },
  { id: "agents", label: "Agents" },
  { id: "experimental", label: "Experimental" },
  { id: "diagnostics", label: "Memory / CPU" },
  { id: "about", label: "About" }
];

/**
 * Sections whose nav row expands into a sub-list.
 *
 * A child is not a pane of its own: it names a card inside the parent's pane
 * and scrolls to it. That is the whole contract, and it is why a group's
 * children can carry live status — the nav is reporting on something already
 * on the other side of one click, not promising a screen that does not exist.
 */
const SETTINGS_NAV_GROUPS = new Set<SettingsSection>(["forges"]);

/**
 * Where the reader is.
 *
 * `focus` is an object rather than the child's slug, because the pane compares
 * requests by identity: clicking the same child twice has to scroll back to a
 * card the reader has since scrolled past, and two equal strings cannot say
 * "asked again". `openRoute` mints a fresh one per click.
 */
type SettingsRoute = {
  section: SettingsSection;
  focus?: SettingsFocusRequest;
};

type SettingsNavChild = {
  label: string;
  /** The `SettingsSection` `sectionId` this scrolls the pane to. Also the
   *  React key — one value, so the key and the route id cannot drift apart. */
  sectionId: string;
  /** Status dot tone. Absent while nothing is known. */
  dot?: ForgeNavDot;
  /** Trailing word, so colour is never the only channel. */
  chip?: string;
  /** Accessible name, once there is a state to report. */
  stateLabel?: string;
};

/**
 * One forge's nav row: its name, the card it scrolls to, and the state an
 * operator wants to read without opening the pane.
 *
 * The dot is `aria-hidden` and the chip is a fragment ("sign in"), so the row
 * states its condition in full for assistive technology — the same sentence the
 * pane's live region reads, from the same function, rather than a second
 * phrasing of it here. Without the name the computed one would be the contents:
 * "GitHub sign in".
 */
function forgeNavChild(
  kind: ForgeKind,
  forges: ForgeStatus[] | undefined
): SettingsNavChild {
  const base = { label: forgeLabel(kind), sectionId: kind };
  const state = forgeProductState(forges?.find((forge) => forge.kind === kind));
  // `unknown` — no probe has answered yet. No dot and no word, because that
  // reads as "we do not know", which is honest: a neutral dot would be a guess
  // and a green one a wrong guess, and this row's whole job is to be trusted at
  // a glance.
  if (state === "unknown") return base;
  const { dot, chip } = FORGE_STATE_NAV[state];
  return {
    ...base,
    dot,
    stateLabel: forgeStateSentence(kind, state),
    ...(chip === undefined ? {} : { chip })
  };
}

/**
 * The Settings window (boots on the `#settings` hash route). A shared
 * auxiliary title strip sits above the section nav and content pane so
 * Windows caption controls and macOS traffic lights occupy the same chrome as
 * every helper window.
 */
export function SettingsWindow() {
  const settings = useAppSettings();
  // Read here rather than inside the Forges pane, because the nav shows a dot
  // for a product whose pane the reader has not opened — which is the point of
  // the children. Main answers from cache, so this costs one IPC per window.
  const forges = useForgeStatuses();
  const [route, setRoute] = useState<SettingsRoute>({ section: "general" });
  // Which groups are unfolded. Everything starts folded: the initial route is
  // General, so no group holds the reader on open.
  const [openGroups, setOpenGroups] = useState<
    Partial<Record<SettingsSection, boolean>>
  >({});
  const activeLabel =
    SECTIONS.find((entry) => entry.id === route.section)?.label ?? "Settings";

  const toggleGroup = (target: SettingsSection): void => {
    setOpenGroups((current) => ({
      ...current,
      [target]: current[target] !== true
    }));
  };

  // Navigating always reveals the destination's children; only the caret folds
  // a group. So clicking "Forges" both opens the pane and shows what is in it,
  // which is how a reader who never thinks to click a caret still finds them.
  const openRoute = (target: SettingsSection, sectionId?: string): void => {
    setRoute({
      section: target,
      ...(sectionId === undefined ? {} : { focus: { sectionId } })
    });
    if (!SETTINGS_NAV_GROUPS.has(target)) return;
    setOpenGroups((current) =>
      current[target] === true ? current : { ...current, [target]: true }
    );
  };

  return (
    <section className="settings-screen" aria-label="Settings">
      <AuxiliaryTitleBar section="Settings" title={activeLabel} />
      <div className="settings-screen__body">
        <nav className="settings-nav" aria-label="Settings sections">
          <p className="settings-nav__group-label">Settings</p>
          {SECTIONS.map((item) => {
            const isGroup = SETTINGS_NAV_GROUPS.has(item.id);
            const open = openGroups[item.id] === true;
            const sublistId = `settings-nav-sublist-${item.id}`;
            const holdsRoute = route.section === item.id;
            const children = isGroup ? navChildren(item.id, forges) : [];
            // The child that actually carries the marker — routed to, and
            // reachable. Derived rather than inferred from "is there a focus,
            // is the group open", because those are proxies: a folded group's
            // child is inside an inert, aria-hidden sublist, and a focus slug
            // no child matches would leave the marker on nothing at all.
            const markedChild =
              holdsRoute && open
                ? children.find(
                    (child) => child.sectionId === route.focus?.sectionId
                  )
                : undefined;
            // Exactly one row in the nav says where the reader is. The parent
            // takes it back whenever no child can hold it.
            const parentMarks = holdsRoute && markedChild === undefined;
            return (
              <Fragment key={item.id}>
                <div className="settings-nav__row">
                  {isGroup ? (
                    <button
                      aria-controls={sublistId}
                      aria-expanded={open}
                      // Named for what it does, not what it is: two adjacent
                      // controls both called "Forges" is the classic screen
                      // reader trap, and the caret's job is the disclosure.
                      aria-label={`${open ? "Collapse" : "Expand"} ${item.label}`}
                      className="settings-nav__caret"
                      type="button"
                      onClick={() => toggleGroup(item.id)}
                    >
                      <span
                        aria-hidden="true"
                        className={`settings-nav__caret-mark${open ? " is-open" : ""}`}
                      />
                    </button>
                  ) : (
                    // Holds the lane so every label starts at one x, group or
                    // not — a nav whose rows jog left and right by 24px reads
                    // as two lists.
                    <span
                      aria-hidden="true"
                      className="settings-nav__caret-spacer"
                    />
                  )}
                  <button
                    aria-current={parentMarks ? "page" : undefined}
                    className={`settings-nav__button${parentMarks ? " is-active" : ""}`}
                    type="button"
                    onClick={() => openRoute(item.id)}
                  >
                    {item.label}
                  </button>
                </div>
                {isGroup ? (
                  // `inert` as well as `aria-hidden`: aria-hidden alone leaves
                  // the buttons focusable, so Tab would walk into a folded
                  // group and land on something nobody can see. The same pair
                  // the section bodies use.
                  <div
                    aria-hidden={!open}
                    className={`settings-nav__sublist${open ? " is-open" : ""}`}
                    id={sublistId}
                    inert={open ? undefined : true}
                  >
                    <div className="settings-nav__sublist-clip">
                      {children.map((child) => {
                        const active = child === markedChild;
                        return (
                          <button
                            key={child.sectionId}
                            aria-current={active ? "page" : undefined}
                            {...(child.stateLabel === undefined
                              ? {}
                              : { "aria-label": child.stateLabel })}
                            className={`settings-nav__subbutton${active ? " is-active" : ""}`}
                            type="button"
                            onClick={() => openRoute(item.id, child.sectionId)}
                          >
                            {/* Always rendered, painted only once there is
                                something to say. The lane it holds is why a
                                row does not jog 14px sideways the instant the
                                probe lands under the reader's eyes. */}
                            <span
                              aria-hidden="true"
                              className={`settings-nav__subdot${
                                child.dot === undefined
                                  ? ""
                                  : ` settings-nav__subdot--${child.dot}`
                              }`}
                            />
                            <span className="settings-nav__sublabel">
                              {child.label}
                            </span>
                            {child.chip === undefined ? null : (
                              <span className="settings-nav__subchip">
                                {child.chip}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </nav>

        <div className="settings-main">
          <div className="settings-content">
            <SettingsSectionBody
              section={route.section}
              {...(route.focus === undefined ? {} : { focus: route.focus })}
              settings={settings}
            />
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

/**
 * A group's children.
 *
 * Forges maps `FORGE_KINDS`, never a pair written here, so a third product
 * arrives in the nav the same way it arrives in the pane: as a registry entry.
 */
function navChildren(
  section: SettingsSection,
  forges: ForgeStatus[] | undefined
): SettingsNavChild[] {
  if (section === "forges") {
    return FORGE_KINDS.map((kind) => forgeNavChild(kind, forges));
  }
  return [];
}

function SettingsSectionBody(props: {
  section: SettingsSection;
  /** The card the nav asked the pane to reveal, if any. */
  focus?: SettingsFocusRequest;
  settings: AppSettingsState;
}) {
  const { settings } = props;

  if (props.section === "profiles") {
    return <ProfilesSettings />;
  }

  if (props.section === "about") {
    return <AboutSettings />;
  }

  if (props.section === "agents") {
    return <LocalAgentsSettings />;
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
        onThemeChange={(theme) => {
          update({ general: { theme } });
        }}
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

  if (props.section === "forges") {
    // One pane, one section per product. It was two sibling cards — a flat host
    // list above a per-forge summary — which rendered outside `.settings-stack`
    // and so lost the 14px gap and 760px column every other pane has.
    return (
      <ForgesSettings
        saving={settings.saving}
        {...(props.focus === undefined ? {} : { focusSection: props.focus })}
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
