import { copyTextAsCodeBlock } from "../../lib/copyText";
import { CloseGlyph } from "../../lib/CloseGlyph";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import type { Toast } from "../../lib/toast";

// PwrAgnt's AppNoticeToast layout and controls, with PwrGit's clipboard and
// tooltip adapters. Grouped sticky notices have no expiry timer.
export function AppNoticeToast({ notice, navigation, onDismiss }: {
  notice: Toast;
  navigation: {
    current: number;
    total: number;
    onPrevious?: () => void;
    onNext?: () => void;
    dismissAll?: { label: string; onDismiss: () => void };
  };
  onDismiss: () => void;
}) {
  const tip = useViewportTooltip();
  const facts = notice.facts ?? [];
  const copyValue = notice.copyText ?? [notice.title, notice.message, notice.detail,
    ...facts.map((fact) => `${fact.label}: ${fact.value}`)].filter(Boolean).join("\n");
  return (
    <aside className="app-notice-toast" data-toast-group={notice.dismissGroup?.key}
      data-notice-id={notice.id} role="status" aria-live="polite">
      <div className="app-notice-toast__head">
        <span className="app-notice-toast__dot" aria-hidden="true" />
        <p className="app-notice-toast__title">{notice.title}</p>
        <div className="app-notice-toast__actions">
          <button className="app-notice-toast__icon-button" type="button" aria-label="Copy notice"
            {...hoverTooltip(tip, "Copy notice")} onClick={() => { void copyTextAsCodeBlock(copyValue); }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
          <button className="app-notice-toast__icon-button" type="button" aria-label="Dismiss notice"
            {...hoverTooltip(tip, "Dismiss notice")} onClick={onDismiss}>
            <CloseGlyph size={13} />
          </button>
        </div>
      </div>
      <div className="app-notice-toast__content">
        <p className="app-notice-toast__message">{notice.message}</p>
        {notice.detail && <p className="app-notice-toast__detail">{notice.detail}</p>}
        {facts.length > 0 && <dl className="app-notice-toast__facts">
          {facts.map((fact) => <div key={fact.label} className="app-notice-toast__fact"><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
        </dl>}
      </div>
      <div className="app-notice-toast__footer">
        <nav className="app-notice-toast__navigation" aria-label="Durable notices">
          <button className="app-notice-toast__icon-button" type="button" aria-label="Previous notice"
            disabled={!navigation.onPrevious} onClick={navigation.onPrevious}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <span className="app-notice-toast__position">{navigation.current} of {navigation.total}</span>
          <button className="app-notice-toast__icon-button" type="button" aria-label="Next notice"
            disabled={!navigation.onNext} onClick={navigation.onNext}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
          </button>
        </nav>
        {navigation.dismissAll && <div className="app-notice-toast__custom-actions">
          <button className="app-notice-toast__button app-notice-toast__dismiss-all" type="button"
            aria-label={`Dismiss all ${navigation.dismissAll.label}`} onClick={navigation.dismissAll.onDismiss}>Dismiss all</button>
        </div>}
      </div>
      {tip.tooltipNode}
    </aside>
  );
}
