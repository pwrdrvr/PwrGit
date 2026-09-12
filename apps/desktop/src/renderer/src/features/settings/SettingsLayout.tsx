import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";

/**
 * Layout primitives for the Settings window, ported from PwrAgnt's
 * SettingsLayout: compose `SettingsSectionStack`, `SettingsPanelHead`,
 * `SettingsSection`, and `SettingsField` instead of rolling per-pane markup so
 * spacing, typography, and accessibility stay consistent across panes.
 *
 * - stack: the pane's own scroll column — 14px gaps, 760px max-width, and the
 *   collapse state its sections share
 * - pane head: eyebrow + title + helper paragraph, plus Collapse/Expand all
 * - section cards: a disclosure header — eyebrow + title + optional status chip
 * - field rows: label column on the left, control + help on the right
 *
 * **Every pane must render its sections inside a `SettingsSectionStack`.** The
 * gap and the max-width live on that element, so a pane that returns a bare
 * fragment instead loses both: Settings → Forges did exactly that and rendered
 * 919px-wide cards with their borders touching, in a window where every other
 * pane's are 760px with 14px between them. A section outside a stack still
 * renders — `AgentConsentWindow` has one, deliberately — but as a plain card
 * with no disclosure, because there is nothing to remember its state.
 */

export type SettingsChipTone = "default" | "ok" | "warn" | "err";

/** The chip's class for one tone. Exported so a pane rendering its own chip
 *  gets the same pill as `SettingsSection`'s header rather than a second copy of
 *  this expression — "one state chip family in the Settings window". */
export function settingsChipClass(tone: SettingsChipTone = "default"): string {
  return tone === "default"
    ? "settings-card__chip"
    : `settings-card__chip settings-card__chip--${tone}`;
}

type SectionRegistration = {
  /** The header element, so roving focus and Collapse all can reach it. */
  element: HTMLElement;
  id: string;
};

type SettingsPaneContextValue = {
  allCollapsed: boolean;
  allExpanded: boolean;
  collapseAll: () => void;
  collapsed: Record<string, boolean>;
  expandAll: () => void;
  paneId: string;
  registerSection: (section: SectionRegistration) => () => void;
  sections: SectionRegistration[];
  toggleSection: (sectionId: string) => void;
};

const SettingsPaneContext = createContext<SettingsPaneContextValue | null>(null);

/**
 * Collapse state, per pane, for as long as the window is open.
 *
 * A module-level map rather than pane state: switching to another pane in the
 * left nav unmounts this one entirely, and a fold the user just made must not
 * be undone by the trip. It is deliberately NOT persisted to settings — which
 * sections you had folded is a reading position, not a preference, and writing
 * it would put a settings write behind every disclosure click.
 */
const collapsedByPane = new Map<string, Record<string, boolean>>();

function slugForSectionId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * One pane's column of sections.
 *
 * Owns the 14px gap and the 760px max-width every pane is measured against,
 * and the collapse state its sections share. `paneId` keys that state, so it
 * must be stable and unique per pane.
 */
export function SettingsSectionStack(props: {
  "aria-label": string;
  paneId: string;
  /** Extra class for a pane that needs its own column rule (see `--agents`). */
  className?: string;
  children: ReactNode;
}) {
  const [sections, setSections] = useState<SectionRegistration[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(
    () => collapsedByPane.get(props.paneId) ?? {}
  );

  /** Every write goes through here, or the module map falls out of step with
   *  render state and the next visit to this pane restores a stale fold. */
  const update = useCallback(
    (next: (current: Record<string, boolean>) => Record<string, boolean>) => {
      setCollapsed((current) => {
        const value = next(current);
        collapsedByPane.set(props.paneId, value);
        return value;
      });
    },
    [props.paneId]
  );

  const registerSection = useCallback((section: SectionRegistration) => {
    setSections((current) => {
      const at = current.findIndex((entry) => entry.id === section.id);
      if (at === -1) return [...current, section];
      const next = [...current];
      next[at] = section;
      return next;
    });
    return () => {
      setSections((current) =>
        current.filter((entry) => entry.id !== section.id)
      );
    };
  }, []);

  const toggleSection = useCallback(
    (sectionId: string) => {
      update((current) => ({
        ...current,
        [sectionId]: current[sectionId] !== true
      }));
    },
    [update]
  );

  const setAll = useCallback(
    (value: boolean) => {
      update((current) => {
        const next = { ...current };
        for (const section of sections) next[section.id] = value;
        return next;
      });
    },
    [sections, update]
  );

  const collapseAll = useCallback(() => setAll(true), [setAll]);
  const expandAll = useCallback(() => setAll(false), [setAll]);

  // Both false while nothing has registered yet, which is what keeps the bulk
  // controls off the screen entirely on a pane that has no sections.
  const allCollapsed =
    sections.length > 0 &&
    sections.every((section) => collapsed[section.id] === true);
  const allExpanded =
    sections.length > 0 &&
    sections.every((section) => collapsed[section.id] !== true);

  const value = useMemo<SettingsPaneContextValue>(
    () => ({
      allCollapsed,
      allExpanded,
      collapseAll,
      collapsed,
      expandAll,
      paneId: props.paneId,
      registerSection,
      sections,
      toggleSection
    }),
    [
      allCollapsed,
      allExpanded,
      collapseAll,
      collapsed,
      expandAll,
      props.paneId,
      registerSection,
      sections,
      toggleSection
    ]
  );

  return (
    <SettingsPaneContext.Provider value={value}>
      <div
        aria-label={props["aria-label"]}
        className={`settings-stack${props.className === undefined ? "" : ` ${props.className}`}`}
      >
        {props.children}
      </div>
    </SettingsPaneContext.Provider>
  );
}

export function SettingsPanelHead(props: {
  eyebrow: string;
  title: ReactNode;
  help?: ReactNode;
  /** Optional right-side action (e.g. "Add profile" button). */
  action?: ReactNode;
}) {
  const pane = useContext(SettingsPaneContext);
  // Only once something has registered: a head that rendered them from the
  // start would offer to collapse nothing for the length of the first read.
  const bulk = pane !== null && pane.sections.length > 0 ? <BulkControls /> : null;

  return (
    <header className="settings-head">
      <div className="settings-head__text">
        <p className="settings-head__eyebrow">{props.eyebrow}</p>
        <h1 className="settings-head__title">{props.title}</h1>
        {props.help ? <p className="settings-head__help">{props.help}</p> : null}
      </div>
      {bulk !== null || props.action ? (
        <div className="settings-head__action">
          {bulk}
          {props.action}
        </div>
      ) : null}
    </header>
  );
}

function BulkControls() {
  const pane = useContext(SettingsPaneContext);
  if (pane === null || pane.sections.length === 0) return null;

  return (
    <div className="settings-head__bulk" aria-label="Section controls">
      {/* Genuinely unavailable, not in-flight, so `disabled` is right here —
          unlike the busy controls elsewhere in Settings, which use
          aria-disabled to keep Chromium from blurring them mid-operation. */}
      <button
        className="settings-button settings-button--quiet"
        disabled={pane.allCollapsed}
        type="button"
        onClick={pane.collapseAll}
      >
        Collapse all
      </button>
      <button
        className="settings-button settings-button--quiet"
        disabled={pane.allExpanded}
        type="button"
        onClick={pane.expandAll}
      >
        Expand all
      </button>
    </div>
  );
}

export function SettingsSection(props: {
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  children: ReactNode;
  /** Optional right-side chip in the card header. */
  chip?: ReactNode;
  chipKind?: SettingsChipTone;
  /**
   * Stable key for this section's collapse state. Defaults to the title, which
   * is right until two sections share one or a title carries live data —
   * a per-product section titled "GitHub" is fine, one titled "GitHub (2 on)"
   * would lose its fold every time the count changed.
   */
  sectionId?: string;
}) {
  const generatedId = useId();
  const pane = useContext(SettingsPaneContext);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const slug = slugForSectionId(props.sectionId ?? props.title);
  const sectionId = `${pane?.paneId ?? "global"}-${slug === "" ? generatedId : slug}`;
  const headingId = `settings-section-${sectionId}-heading`;
  const bodyId = `settings-section-${sectionId}-body`;
  const collapsed = pane?.collapsed[sectionId] === true;
  const chipClass = settingsChipClass(props.chipKind);
  const registerSection = pane?.registerSection;

  // Layout, not effect: the header must be registered before the pane head
  // paints, or Collapse all flickers in one frame after the sections appear.
  useLayoutEffect(() => {
    const element = headerRef.current;
    if (registerSection === undefined || element === null) return;
    return registerSection({ element, id: sectionId });
  }, [registerSection, sectionId]);

  const focusSibling = (
    direction: "next" | "previous" | "first" | "last"
  ): void => {
    if (pane === null) return;
    const { sections } = pane;
    const at = sections.findIndex((section) => section.id === sectionId);
    if (at === -1) return;
    const index =
      direction === "next"
        ? Math.min(sections.length - 1, at + 1)
        : direction === "previous"
          ? Math.max(0, at - 1)
          : direction === "first"
            ? 0
            : sections.length - 1;
    sections[index]?.element.focus();
  };

  const onHeaderKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (pane === null) return;
    // A div with role="button" gets neither for free; both are required of one
    // (SC 2.1.1), and Space would otherwise scroll the pane instead.
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pane.toggleSection(sectionId);
      return;
    }
    const moves: Record<string, "next" | "previous" | "first" | "last"> = {
      ArrowDown: "next",
      ArrowUp: "previous",
      Home: "first",
      End: "last"
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    focusSibling(move);
  };

  const header = (
    <>
      <div className="settings-panel__header-main">
        {props.eyebrow ? (
          <p className="settings-panel__eyebrow">{props.eyebrow}</p>
        ) : null}
        <h2 className="settings-panel__title" id={headingId}>
          {props.title}
        </h2>
        {props.description ? (
          <p className="settings-panel__description">{props.description}</p>
        ) : null}
      </div>
      {props.chip ? <span className={chipClass}>{props.chip}</span> : null}
    </>
  );

  // No pane to remember the state, so no disclosure is offered. Rendering the
  // chevron and role="button" anyway would promise a fold that cannot happen —
  // `AgentConsentWindow` renders a section on its own, outside any stack.
  if (pane === null) {
    return (
      <section className="settings-panel" aria-label={props.title}>
        <div className="settings-panel__header">{header}</div>
        <div className="settings-panel__body">{props.children}</div>
      </section>
    );
  }

  return (
    <section
      aria-label={props.title}
      className={`settings-panel settings-panel--collapsible${
        collapsed ? " is-collapsed" : ""
      }`}
    >
      <div
        ref={headerRef}
        aria-controls={bodyId}
        aria-expanded={!collapsed}
        // Named rather than labelled by the heading: the header also holds the
        // description and a live status chip, and a role="button" computes its
        // name from all of its contents — which would read the whole paragraph
        // out on focus and change the button's name whenever the chip did.
        aria-label={props.title}
        className="settings-panel__header settings-panel__disclosure"
        role="button"
        tabIndex={0}
        onClick={() => pane.toggleSection(sectionId)}
        onKeyDown={onHeaderKeyDown}
      >
        <ChevronGlyph />
        {header}
      </div>
      {/* `inert` and not an unmount: the body keeps its scroll position and its
          in-flight state across a fold, and `inert` is what takes its controls
          out of the tab order — `aria-hidden` alone leaves them focusable. */}
      <div
        aria-hidden={collapsed}
        className="settings-panel__body-clip"
        id={bodyId}
        inert={collapsed ? true : undefined}
      >
        <div className="settings-panel__body">{props.children}</div>
      </div>
    </section>
  );
}

/** The disclosure caret. Rotated by CSS rather than swapped for a second path,
 *  so the two states cannot drift and the turn can be animated. */
function ChevronGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="settings-panel__chevron"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * Field row: label + sub-line stack on the left, control + help stack on
 * the right.
 */
export function SettingsField(props: {
  label: string;
  /** Description below the label. Single sentence framing. */
  sub?: ReactNode;
  /** Hint below the control. */
  help?: ReactNode;
  control: ReactNode;
  /** Optional inline error message rendered under the control. */
  error?: ReactNode;
}) {
  return (
    <div className="settings-field">
      <div className="settings-field__label">
        <span>{props.label}</span>
        {props.sub ? (
          <span className="settings-field__sub">{props.sub}</span>
        ) : null}
      </div>
      <div className="settings-field__control">
        {props.control}
        {props.help ? (
          <span className="settings-field__help">{props.help}</span>
        ) : null}
        {props.error ? (
          <p className="settings-field__error" role="alert">
            {props.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Segmented radio-group control (start delay, trigger mode, ...). */
export function SettingsSegmented<TValue extends string | number>(props: {
  "aria-label": string;
  disabled?: boolean;
  options: Array<{ value: TValue; label: string; meta?: string }>;
  value: TValue;
  onChange: (value: TValue) => void;
}) {
  return (
    <div
      className="settings-segmented"
      role="radiogroup"
      aria-label={props["aria-label"]}
    >
      {props.options.map((option) => (
        <button
          key={String(option.value)}
          aria-checked={props.value === option.value}
          className={`settings-segmented__button${
            props.value === option.value ? " is-active" : ""
          }`}
          disabled={props.disabled}
          role="radio"
          type="button"
          onClick={() => props.onChange(option.value)}
        >
          <span>{option.label}</span>
          {option.meta !== undefined ? (
            <span className="settings-segmented__meta">{option.meta}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
