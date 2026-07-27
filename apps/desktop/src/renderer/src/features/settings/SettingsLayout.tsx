import type { ReactNode } from "react";

/**
 * Layout primitives for the Settings window, ported (simplified) from
 * PwrAgnt's SettingsLayout: compose `SettingsPanelHead`, `SettingsSection`,
 * and `SettingsField` instead of rolling per-pane markup so spacing,
 * typography, and accessibility stay consistent across panes.
 *
 * - pane head: eyebrow + title + helper paragraph
 * - section cards: eyebrow + title + optional status chip
 * - field rows: label column on the left, control + help on the right
 *
 * PwrAgnt's collapsible-section machinery is intentionally dropped — PwrGit's
 * panes are short enough to render flat.
 */

export type SettingsChipTone = "default" | "ok" | "warn" | "err";

export function SettingsPanelHead(props: {
  eyebrow: string;
  title: ReactNode;
  help?: ReactNode;
  /** Optional right-side action (e.g. "Add profile" button). */
  action?: ReactNode;
}) {
  return (
    <header className="settings-head">
      <div className="settings-head__text">
        <p className="settings-head__eyebrow">{props.eyebrow}</p>
        <h1 className="settings-head__title">{props.title}</h1>
        {props.help ? <p className="settings-head__help">{props.help}</p> : null}
      </div>
      {props.action ? (
        <div className="settings-head__action">{props.action}</div>
      ) : null}
    </header>
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
}) {
  const chipClass =
    props.chipKind !== undefined && props.chipKind !== "default"
      ? `settings-card__chip settings-card__chip--${props.chipKind}`
      : "settings-card__chip";

  return (
    <section className="settings-panel" aria-label={props.title}>
      <div className="settings-panel__header">
        <div className="settings-panel__header-main">
          {props.eyebrow ? (
            <p className="settings-panel__eyebrow">{props.eyebrow}</p>
          ) : null}
          <h2 className="settings-panel__title">{props.title}</h2>
          {props.description ? (
            <p className="settings-panel__description">{props.description}</p>
          ) : null}
        </div>
        {props.chip ? <span className={chipClass}>{props.chip}</span> : null}
      </div>
      <div className="settings-panel__body">{props.children}</div>
    </section>
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
