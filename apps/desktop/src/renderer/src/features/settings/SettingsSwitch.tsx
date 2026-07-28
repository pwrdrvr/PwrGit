/**
 * Track-and-thumb switch primitive used by every settings toggle (ported from
 * PwrAgnt). Rendered as `<button role="switch">` so screen readers and tests
 * still recognize it as a toggle; Space and Enter activate it natively.
 */
export function SettingsSwitch(props: {
  checked: boolean;
  disabled?: boolean;
  /** Used for `aria-label` and the visible "On"/"Off" word. */
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      aria-checked={props.checked}
      aria-label={props.label}
      className={`settings-switch${props.checked ? " is-on" : ""}`}
      disabled={props.disabled}
      role="switch"
      type="button"
      onClick={() => props.onChange(!props.checked)}
    >
      <span aria-hidden="true" className="settings-switch__track">
        <span className="settings-switch__thumb" />
      </span>
      <span aria-hidden="true" className="settings-switch__word">
        {props.checked ? "On" : "Off"}
      </span>
    </button>
  );
}
