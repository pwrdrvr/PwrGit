import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  FORGE_KINDS,
  forgeLabel,
  parseSettingsRouteHash,
  type AppSettingsPatch,
  type AppSettingsSnapshot,
  type DiagnosticsSettings as DiagnosticsSettingsShape,
  type ForgeKind,
  type ForgeStatus,
  type ProfileId,
  type SettingsPage,
  type SettingsRoute as SettingsDeepLink
} from "@pwrgit/shared";
import { subscribe } from "../../lib/pwrgit";
import { prefersReducedMotion } from "../../lib/reducedMotion";
import { useProfiles } from "../../state/useProfiles";
import { AuxiliaryTitleBar } from "../chrome/AuxiliaryTitleBar";
import { AboutSettings } from "./AboutSettings";
import type { AiProfileSelection } from "./AiProfilePicker";
import { AiFeaturesSettings } from "./AiFeaturesSettings";
import { AiProvidersProvider, useAiProvidersContext } from "./AiProvidersContext";
import { AiProvidersSettings } from "./AiProvidersSettings";
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
  forgeStateSentence
} from "./ForgeProductSection";
import type { AiProviderStatus } from "./ai-provider-status";
import {
  SETTINGS_NAV_GROUPS,
  aiFeatureNavChildren,
  aiProviderNavChild,
  paneScrollForRoute,
  type SettingsNavChild
} from "./settings-nav";
import type { SettingsFocusRequest } from "./SettingsLayout";
import { useForgeStatuses } from "./useForgeStatuses";
import { useAppSettings, type AppSettingsState } from "./useAppSettings";

/**
 * Nav order and labels. The ids are `SETTINGS_PAGES` (@pwrgit/shared), the
 * same list main validates a `settings:open` deep link against.
 *
 * "Local Agents" and not "Agents": the AI pages configure agents PwrGit calls
 * OUT to, this one governs agents calling IN over MCP, and a bare "Agents"
 * beside "AI Providers" reads as either. The id stays `agents` so nothing that
 * already names the page moves.
 */
const SECTIONS: Array<{ id: SettingsPage; label: string }> = [
  { id: "general", label: "General" },
  { id: "updates", label: "Updates" },
  { id: "profiles", label: "Profiles" },
  { id: "forges", label: "Forges" },
  { id: "ai-providers", label: "AI Providers" },
  { id: "ai-features", label: "AI Features" },
  { id: "agents", label: "Local Agents" },
  { id: "experimental", label: "Experimental" },
  { id: "diagnostics", label: "Memory / CPU" },
  { id: "about", label: "About" }
];

/**
 * Where the reader is.
 *
 * `focus` is an object rather than the child's slug, because the pane compares
 * requests by identity: clicking the same child twice has to scroll back to a
 * card the reader has since scrolled past, and two equal strings cannot say
 * "asked again". `openRoute` mints a fresh one per click. `request` counts
 * every navigation for the same reason, for the pane's own scroll.
 */
type SettingsRoute = {
  section: SettingsPage;
  focus?: SettingsFocusRequest;
  request: number;
};

/** The route a deep link lands on. */
function routeFromDeepLink(link: SettingsDeepLink | null, request: number): SettingsRoute {
  if (link === null) return { section: "general", request };
  return {
    section: link.page,
    request,
    ...(link.sub === undefined ? {} : { focus: { sectionId: link.sub } })
  };
}

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
 * The profile the AI pages edit.
 *
 * The Settings window serves every profile, and AI settings belong to one, so
 * the window holds a choice: the one a deep link named, else the one the
 * reader picked, else the active profile, else the first. A choice whose
 * profile is deleted falls through to the next rule rather than editing a
 * profile that no longer exists.
 */
function useAiProfileSelection(): AiProfileSelection & {
  choose: (profileId: ProfileId) => void;
} {
  const { profiles, activeProfileId } = useProfiles();
  const [chosen, setChosen] = useState<ProfileId | null>(
    () => parseSettingsRouteHash(window.location.hash)?.profileId ?? null
  );
  const exists = (id: ProfileId | null): id is ProfileId =>
    id !== null && profiles.some((profile) => profile.id === id);
  const value = exists(chosen)
    ? chosen
    : exists(activeProfileId)
      ? activeProfileId
      : (profiles[0]?.id ?? null);
  return { profiles, value, onChange: setChosen, choose: setChosen };
}

/**
 * The Settings window (boots on the `#settings` hash route, or a deep link —
 * `#settings?page=…&sub=…&profile=…` — minted by `settings:open`). A shared
 * auxiliary title strip sits above the section nav and content pane so
 * Windows caption controls and macOS traffic lights occupy the same chrome as
 * every helper window.
 */
export function SettingsWindow() {
  const aiProfile = useAiProfileSelection();
  // Above the nav AND the panes: the AI Providers children's dots and the
  // cards they point at are one read (AiProvidersContext).
  return (
    <AiProvidersProvider profileId={aiProfile.value}>
      <SettingsWindowBody aiProfile={aiProfile} />
    </AiProvidersProvider>
  );
}

function SettingsWindowBody(props: {
  aiProfile: ReturnType<typeof useAiProfileSelection>;
}) {
  const { aiProfile } = props;
  const settings = useAppSettings();
  // Read here rather than inside the Forges pane, because the nav shows a dot
  // for a product whose pane the reader has not opened — which is the point of
  // the children. Main answers from cache, so this costs one IPC per window.
  const forges = useForgeStatuses();
  const ai = useAiProvidersContext();
  const [route, setRoute] = useState<SettingsRoute>(() =>
    routeFromDeepLink(parseSettingsRouteHash(window.location.hash), 0)
  );
  // Which groups are unfolded. A group the window boots into starts open —
  // navigating to a group always reveals its children — and everything else
  // starts folded.
  const [openGroups, setOpenGroups] = useState<
    Partial<Record<SettingsPage, boolean>>
  >(() => (SETTINGS_NAV_GROUPS.has(route.section) ? { [route.section]: true } : {}));
  const activeLabel =
    SECTIONS.find((entry) => entry.id === route.section)?.label ?? "Settings";

  const toggleGroup = (target: SettingsPage): void => {
    setOpenGroups((current) => ({
      ...current,
      [target]: current[target] !== true
    }));
  };

  // Navigating always reveals the destination's children; only the caret folds
  // a group. So clicking "Forges" both opens the pane and shows what is in it,
  // which is how a reader who never thinks to click a caret still finds them.
  const openRoute = (target: SettingsPage, sectionId?: string): void => {
    setRoute((current) => ({
      section: target,
      request: current.request + 1,
      ...(sectionId === undefined ? {} : { focus: { sectionId } })
    }));
    if (!SETTINGS_NAV_GROUPS.has(target)) return;
    setOpenGroups((current) =>
      current[target] === true ? current : { ...current, [target]: true }
    );
  };
  const openRouteRef = useRef(openRoute);
  openRouteRef.current = openRoute;

  // A `settings:open` while this window is already up: main focuses it and
  // pushes the route here instead of reloading the page.
  const { choose } = aiProfile;
  useEffect(
    () =>
      subscribe("settings:navigate", (link) => {
        if (link.profileId !== undefined) choose(link.profileId);
        openRouteRef.current(link.page, link.sub);
      }),
    [choose]
  );

  // The AI Providers children report discovery, so unfolding the group is a
  // request for it — the same as opening either AI pane. Nothing is probed for
  // a reader who never goes near AI.
  const aiNavOpen = openGroups["ai-providers"] === true;
  const { request } = ai;
  useEffect(() => {
    if (aiNavOpen) request();
  }, [aiNavOpen, request]);

  // The pane's own scroll, per `paneScrollForRoute`: a new page starts at the
  // top instead of at the last one's offset, and a card request leaves the
  // scroll to the card's reveal.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const shownRoute = useRef(route);
  useLayoutEffect(() => {
    const prev = shownRoute.current;
    shownRoute.current = route;
    const element = contentRef.current;
    if (element === null || prev === route) return;
    const move = paneScrollForRoute(
      { page: prev.section, sub: prev.focus?.sectionId ?? null, request: prev.request },
      { page: route.section, sub: route.focus?.sectionId ?? null, request: route.request }
    );
    if (move === "none") return;
    // Without `scrollTo` (jsdom) there is no travel to animate, only a place
    // to be; `scrollTop` gets the reader there either way.
    if (move === "top" || typeof element.scrollTo !== "function") {
      element.scrollTop = 0;
      return;
    }
    element.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [route]);

  const editDefaults = (): void => openRoute("ai-features", "default-agents");

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
            const children = isGroup ? navChildren(item.id, forges, ai.statuses) : [];
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
          <div className="settings-content" ref={contentRef}>
            <SettingsSectionBody
              section={route.section}
              {...(route.focus === undefined ? {} : { focus: route.focus })}
              settings={settings}
              aiProfile={aiProfile}
              onEditDefaults={editDefaults}
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
 * AI Providers maps the statuses its cards render, so a dot and its card are
 * one answer; AI Features' children are plain jump links.
 */
function navChildren(
  section: SettingsPage,
  forges: ForgeStatus[] | undefined,
  aiStatuses: readonly AiProviderStatus[]
): SettingsNavChild[] {
  if (section === "forges") {
    return FORGE_KINDS.map((kind) => forgeNavChild(kind, forges));
  }
  if (section === "ai-providers") return aiStatuses.map(aiProviderNavChild);
  if (section === "ai-features") return aiFeatureNavChildren();
  return [];
}

function SettingsSectionBody(props: {
  section: SettingsPage;
  /** The card the nav asked the pane to reveal, if any. */
  focus?: SettingsFocusRequest;
  settings: AppSettingsState;
  aiProfile: AiProfileSelection;
  onEditDefaults: () => void;
}) {
  const { settings } = props;
  const focus = props.focus === undefined ? {} : { focusSection: props.focus };

  if (props.section === "profiles") {
    return <ProfilesSettings />;
  }

  // Neither AI pane reads the app snapshot: their settings are per profile
  // and come from `AiProvidersContext`.
  if (props.section === "ai-providers") {
    return (
      <AiProvidersSettings
        profile={props.aiProfile}
        onEditDefaults={props.onEditDefaults}
        {...focus}
      />
    );
  }

  if (props.section === "ai-features") {
    return <AiFeaturesSettings profile={props.aiProfile} {...focus} />;
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
      <ForgesSettings saving={settings.saving} {...focus} />
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
