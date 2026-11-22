import { useId, useState } from "react";
import {
  HOT_CPU_RULE_DURATIONS, HOT_CPU_RULE_LABELS, hotCpuRuleIntervalMs, isHotCpuThreshold, toggleHotCpuRule,
  type HotCpuCaptureRules, type HotCpuEffectiveRule, type HotCpuRuleOverride, type HotCpuTriggerMode
} from "@pwrgit/shared";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { SettingsField, SettingsSegmented } from "./SettingsLayout";

const LAST_RULE = "At least one rule stays on. To stop capturing, turn off Arm hot CPU capture.";
const THRESHOLD_HELP = "Percent of one CPU core, averaged over each sample. 100% is one core fully busy. Multi-threaded work can go above 100%.";
const SLOW_HELP = "A lower threshold for steady background work that never spikes.";
const HIGH_MODES = [
  { value: "spike", label: "Spike", tooltip: "Starts a capture on one sample at or above the threshold." },
  { value: "sustained", label: "Sustained", tooltip: "Needs every sample in the duration to stay at or above the threshold." }
] satisfies Array<{ value: HotCpuCaptureRules["high"]["mode"]; label: string; tooltip: string }>;

function samples(count: number): string {
  return count === 1 ? "1 sample" : `${count} samples`;
}

function windowLabel(durationMs: number, count: number): string {
  return `${durationMs / 1000} s · ${samples(count)}`;
}

function ThresholdInput(props: { id: HotCpuTriggerMode; value: number; disabled: boolean; onSave: (value: number) => Promise<void> }) {
  const [draft, setDraft] = useState<{ text: string; dirty: boolean } | null>(null);
  const [showError, setShowError] = useState(false);
  const errorId = useId();
  const tip = useViewportTooltip();
  const text = draft?.text ?? String(props.value);
  const thresholdPercent = Number(text);
  const invalid = showError && !isHotCpuThreshold(thresholdPercent);

  return (
    <span className="settings-cpu-rules__threshold">
      <input
        className="settings-input"
        aria-label={`${HOT_CPU_RULE_LABELS[props.id]} threshold percent`}
        aria-invalid={invalid || undefined}
        aria-errormessage={invalid ? errorId : undefined}
        {...hoverTooltip(tip, THRESHOLD_HELP)}
        type="number"
        min={1}
        max={400}
        step={1}
        disabled={props.disabled}
        value={text}
        onChange={(event) => setDraft({ text: event.currentTarget.value, dirty: true })}
        onBlur={(event) => {
          tip.blurFrom(event);
          if (!isHotCpuThreshold(thresholdPercent)) {
            setShowError(true);
            return;
          }
          setShowError(false);
          if (draft?.dirty) {
            const submitted = { text: String(thresholdPercent), dirty: false };
            setDraft(submitted);
            // A new draft can begin before this write settles.
            void props.onSave(thresholdPercent).then(() => {
              setDraft((current) => current === submitted ? null : current);
            });
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft(null);
            setShowError(false);
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (isHotCpuThreshold(thresholdPercent)) event.currentTarget.blur();
            else setShowError(true);
          } else if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            const next = (thresholdPercent || props.value) + (event.key === "ArrowUp" ? 10 : -10);
            setDraft({ text: String(Math.min(400, Math.max(1, next))), dirty: true });
          }
        }}
      />
      {invalid ? <span id={errorId} className="settings-cpu-rules__error" role="alert">Enter a whole number from 1 to 400.</span> : null}
      {tip.tooltipNode}
    </span>
  );
}

function summarize(rule: HotCpuEffectiveRule, intervalMs: number): string {
  const interval = `${intervalMs / 1000} s`;
  const window = rule.sampleCount === 1 ? `one ${interval} sample`
    : `${rule.sampleCount} consecutive ${interval} samples (${rule.sampleCount * intervalMs / 1000} s)`;
  return `${HOT_CPU_RULE_LABELS[rule.id]} at ${rule.thresholdPercent}% over ${window}`;
}

export type HotCpuRulesEdit = (current: HotCpuCaptureRules) => HotCpuCaptureRules;

export function HotCpuRulesField(props: {
  rules: HotCpuCaptureRules;
  override: HotCpuRuleOverride | undefined;
  onEdit: (edit: HotCpuRulesEdit) => Promise<void>;
}) {
  const { rules, override, onEdit } = props;
  const labelId = useId();
  const summaryId = useId();
  const [lastRuleStatus, setLastRuleStatus] = useState("");
  const tip = useViewportTooltip();
  const cadence = hotCpuRuleIntervalMs(rules);
  const highMode = rules.high.mode;
  const enabled = [
    ...(rules.high.enabled ? [highMode] : []),
    ...(rules.slowburn.enabled ? ["slowburn" as const] : [])
  ];
  const effective = override?.rules ?? enabled.map((id) => ({
    id, ...rules[id], sampleCount: rules[id].durationMs / cadence
  }));
  const [high, slow] = effective;
  const redundant = high && slow && slow.thresholdPercent >= high.thresholdPercent &&
    slow.durationMs >= high.durationMs && slow.sampleCount >= high.sampleCount;

  const checkbox = (group: "high" | "slowburn", label: string) => {
    const lastRule = rules[group].enabled && enabled.length === 1;
    return (
      <label className="settings-cpu-rules__check">
        <input
          type="checkbox"
          checked={rules[group].enabled}
          aria-disabled={lastRule || undefined}
          {...hoverTooltip(tip, lastRule ? LAST_RULE : group === "slowburn" ? SLOW_HELP : undefined)}
          onChange={() => {
            setLastRuleStatus(lastRule ? LAST_RULE : "");
            if (!lastRule) void onEdit((current) => toggleHotCpuRule(current, group));
          }}
        />
        {label}
      </label>
    );
  };

  const values = (id: HotCpuTriggerMode, disabled: boolean) => (
    <div className="settings-cpu-rules__values">
      <span>at least</span>
      <ThresholdInput
        key={id}
        id={id}
        value={rules[id].thresholdPercent}
        disabled={disabled}
        onSave={(thresholdPercent) => onEdit((current) => current[id].thresholdPercent === thresholdPercent
          ? current : { ...current, [id]: { ...current[id], thresholdPercent } })}
      />
      <span>% CPU for</span>
      <select
        className="settings-select"
        aria-label={`${HOT_CPU_RULE_LABELS[id]} duration`}
        {...hoverTooltip(tip, "Each sample in the duration must meet the threshold. A short burst is averaged with the rest of its sample.")}
        disabled={disabled}
        value={rules[id].durationMs}
        onChange={(event) => {
          const durationMs = Number(event.currentTarget.value);
          void onEdit((current) => ({ ...current, [id]: { ...current[id], durationMs } }));
        }}
      >
        {HOT_CPU_RULE_DURATIONS[id].map((duration) => (
          <option key={duration} value={duration}>{windowLabel(duration, id === "spike" ? 1 : duration / cadence)}</option>
        ))}
      </select>
    </div>
  );

  return (
    <SettingsField
      label="Capture rules"
      labelId={labelId}
      className="settings-field--cpu-rules"
      sub="Start a capture when any checked rule matches. Rules apply to the main process and each window independently."
      control={
        <div className="settings-cpu-rules" role="group" aria-labelledby={labelId} aria-describedby={summaryId}>
          <div className="settings-cpu-rules__rule">
            <div className="settings-cpu-rules__heading">
              {checkbox("high", "High CPU")}
              <SettingsSegmented
                aria-label="High CPU mode"
                disabled={!rules.high.enabled}
                options={HIGH_MODES}
                value={highMode}
                onChange={(mode) => {
                  void onEdit((current) => current.high.mode === mode ? current : { ...current, high: { ...current.high, mode } });
                }}
              />
            </div>
            {values(highMode, !rules.high.enabled)}
          </div>
          <div className="settings-cpu-rules__rule">
            <div className="settings-cpu-rules__heading">
              {checkbox("slowburn", "Slow burn")}
              <span className="settings-field__sub">Lower threshold, longer window</span>
            </div>
            {values("slowburn", !rules.slowburn.enabled)}
          </div>
          {override ? <p className="settings-callout settings-callout--warn">
            The editor shows saved preferences. This session uses environment overrides
            {" "}<code>{override.keys.join(", ")}</code>.
          </p> : null}
          <p className="settings-cpu-rules__summary" id={summaryId} aria-live="polite">
            {effective.length
              ? `Matches ${effective.map((rule) => summarize(rule, override?.intervalMs ?? cadence)).join(" or ")}. CPU is measured per core.`
              : "No capture rules are active."}
          </p>
          {redundant ? <p className="settings-callout settings-callout--warn">
            Slow burn adds no independent trigger with this threshold and window. Set a lower threshold or shorter window to catch different load.
          </p> : null}
          <div role="status" className="settings-cpu-rules__status">{lastRuleStatus}</div>
          {tip.tooltipNode}
        </div>
      }
      help="A rule matches when the last required sample ends. When rules match on the same sample, one capture is saved and names each match."
    />
  );
}
