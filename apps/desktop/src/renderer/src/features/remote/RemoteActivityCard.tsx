import { useEffect, useRef, useState } from "react";
import { dispatch } from "../../lib/pwrgit";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import {
  remoteActivityReport,
  stepHasMeter,
  type RemoteActivityStep,
  type RemoteActivityView
} from "./remote-activity";

/**
 * What one remote operation is doing — or, once it is over, what it did.
 *
 * Shown in the toolbar's status popover and in the toast that keeps an
 * operation reachable after you navigate away from its repository. Both need
 * the same four things — scope, health, Git's own words, and a way out — so
 * they share this card rather than growing two dialects of it.
 *
 * It takes a `RemoteActivityView` rather than a `RemoteActivity` because the
 * card now outlives the record: the popover keeps it up as the receipt for a
 * finished operation, and by then `finish()` has deleted the record it used to
 * read. `liveActivityView` / `settledActivityView` are where the two sources
 * meet, and they are pure.
 */
export function RemoteActivityCard({
  view,
  compact = false,
  onClose
}: {
  view: RemoteActivityView;
  /** Toast placement: tighter, and without the repeated Git output block. */
  compact?: boolean;
  /**
   * Dismiss this card. Given only where dismissal is the user's to make — the
   * pinned popover — which is also what draws the ✕ and the Close button. The
   * toast has no dismissal of its own: it stands for exactly as long as the
   * operation it reports.
   */
  onClose?: () => void;
}) {
  const tip = useViewportTooltip();
  // Destructured so the two null checks below narrow inside the handlers —
  // TypeScript cannot carry a narrowing on `view.x` into a closure.
  const { canceling, operationId } = view;
  // Whether Git's own output is showing. Owned here rather than left to the
  // `<details>` element: the popover re-renders this card every second, and an
  // uncontrolled `open` would be reasserted from props each time — so a user
  // who opened it would watch it shut itself a second later.
  const wantsEvidence = evidenceEarnsAttention(view);
  const [evidenceOpen, setEvidenceOpen] = useState(wantsEvidence);
  const wasWanted = useRef(wantsEvidence);
  useEffect(() => {
    // Opened *for* the user when the operation turns bad, and never closed for
    // them: a card that hid its evidence again as a fetch recovered would take
    // away the thing they were reading.
    if (wantsEvidence && !wasWanted.current) setEvidenceOpen(true);
    wasWanted.current = wantsEvidence;
  }, [wantsEvidence]);
  // Nothing observed yet — every card before its first phase arrives, and
  // every operation that fails before one does.
  const fallback = view.steps.length === 0;
  // A settled card whose rows cannot carry the outcome on their own.
  const headline = view.settled !== null && view.settled !== "ok";
  // Once the health line has had something to say it keeps its place, even
  // when Git starts talking again and the reading goes back to "muted", and
  // through the receipt.
  //
  // A retraction is real information, so the line still updates — what it must
  // not do is vanish. It sits above the evidence and the buttons, and a fetch
  // that stalls for twenty seconds and then resumes would otherwise push them
  // down and pull them back up; dropping it at settle did the same thing at
  // the one moment the user is reading the card most carefully.
  //
  // State set in an effect, never a ref written during render: a render React
  // begins and discards must not be what latches this on. It resets with the
  // card, which every caller keys to the operation it reports.
  const [warned, setWarned] = useState(false);
  useEffect(() => {
    if (view.statusTone === "warn") setWarned(true);
  }, [view.statusTone]);
  // Yielding to the headline is what keeps the settle from saying the same
  // sentence twice: on a failure `statusLabel` is the reason, and it belongs
  // above the rows rather than under them.
  const health = warned && !fallback && !headline;
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (copiedTimer.current !== undefined) {
        window.clearTimeout(copiedTimer.current);
      }
    },
    []
  );

  const copyReport = async (): Promise<void> => {
    // A finished operation has no log left to ask for — the registry drops it
    // in `finish()` — so the tail the view snapshotted IS the record, and the
    // fetch below is skipped rather than asked and answered `null`.
    const lines =
      operationId === null ? view.output : await fullLog(operationId);
    await navigator.clipboard.writeText(remoteActivityReport(view, lines));
    setCopied(true);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className={`remote-activity${compact ? " remote-activity--compact" : ""}`}
    >
      <div className="remote-activity__header">
        <span className="remote-activity__title">{view.title}</span>
        <span className="remote-activity__header-end">
          <span className="remote-activity__elapsed">{view.elapsed}</span>
          {onClose !== undefined && (
            // Always present on a dismissible card, in every state. A card
            // that can take itself away must never be one the user has to
            // race — and under `prefers-reduced-motion` the countdown rail
            // that says it is going is four discrete steps rather than a
            // sweep, so this is the only unambiguous way out.
            <button
              className="remote-activity__close"
              type="button"
              aria-label="Dismiss status"
              {...hoverTooltip(tip, "Dismiss")}
              onClick={onClose}
            >
              ✕
            </button>
          )}
        </span>
      </div>

      {/* The headline, above the detail. Drawn when the card has something to
          say that its rows cannot: an outcome that was not a plain success —
          a failure's reason, a cancel, "your stashed changes came back with
          conflicts" — or when there are no rows at all, which is every card
          before the first phase is observed and every fast failure.

          A *successful* receipt deliberately has none: its rows already say
          what happened, and a sentence restating them is the kind of padding
          that made the old card feel like it was hiding something. */}
      {(headline || fallback) && (
        <p
          className={`remote-activity__status remote-activity__status--${view.statusTone}`}
        >
          {view.statusLabel}
        </p>
      )}

      {fallback ? (
        <>
          {/* The meter belongs to whichever presentation is on screen: to the
              step being worked when there is a list, and to the status line
              when there is not. The toast is the standing case for the
              second — it passes no steps, because a receipt belongs beside the
              button that was pressed and the toast is for a repository the
              user is not looking at.

              Its space is reserved for as long as the operation runs, rather
              than mounted with Git's first progress line and unmounted at
              every phase boundary (`setPhase` clears `progress`, by design —
              the next meter belongs to new work). A block that comes and goes
              three times in a pull moves everything under it six times; an
              empty track that fills is the same information without that. */}
          {view.meterSlot && (
            <div className="remote-activity__meter">
              <Track
                percent={view.percent}
                label={view.meter}
                className="remote-activity__bar"
              />
              <span className="remote-activity__meter-label">
                {view.meter ?? ""}
              </span>
            </div>
          )}
        </>
      ) : (
        <ol className="remote-activity__steps">
          {view.steps.map((step) => (
            <li
              key={step.phase}
              className={`remote-activity__step remote-activity__step--${step.state}`}
            >
              <span className="remote-activity__step-mark" aria-hidden="true">
                {step.state === "done" ? "✓" : step.state === "failed" ? "✕" : "●"}
              </span>
              <span className="remote-activity__step-label">{step.label}</span>
              {step.detail !== null && (
                <span className="remote-activity__step-detail">
                  {step.detail}
                </span>
              )}
              {stepHasMeter(step.phase) && (
                <Track
                  percent={stepPercent(step)}
                  label={step.detail ?? step.label}
                  className="remote-activity__step-bar"
                />
              )}
            </li>
          ))}
        </ol>
      )}

      {/* The health line rides *under* the list, because "no Git output for
          2m 04s" is about the operation rather than about any one step — and
          reading it above "● Fetching updates" would just restate the row it
          sits on. It is the whole reason a wedged fetch is worth looking at. */}
      {health && (
        <p
          className={`remote-activity__status remote-activity__status--${view.statusTone}`}
        >
          {view.statusLabel}
        </p>
      )}

      {!compact && (
        // Git's own words, verbatim. Everything above is PwrGit's reading of
        // the operation; this is the evidence behind it, and the only thing
        // that explains an unfamiliar failure.
        //
        // Collapsed while the operation is healthy, because Git's progress
        // output is `\r`-rewritten — built to be transient in a terminal — and
        // reproducing it here meant a block that grew from nothing to its
        // 108px cap while its last line flickered at Git's own rate. That was
        // the single largest source of the card's churn, and on a healthy
        // operation it explains nothing the step list has not already said.
        //
        // It opens itself the moment it IS the finding: a quiet warning, a
        // failure, or a cancel. Those are exactly the cases a user came to the
        // card to read, and making them hunt for a disclosure would be the
        // same mistake as hiding the card behind an age gate.
        <details className="remote-activity__evidence" open={evidenceOpen}>
          <summary
            className="remote-activity__evidence-summary"
            onClick={(event) => {
              // The browser toggles `open` on a summary click by itself, and
              // React owns that attribute — so let exactly one of them drive
              // it rather than having both arrive at the same answer by luck.
              event.preventDefault();
              setEvidenceOpen(!evidenceOpen);
            }}
          >
            Git output
          </summary>
          {/* Inside the disclosure with the output, and for the same reason.
              `setCommand` fires per Git INVOCATION rather than per phase — a
              pull runs eight of them — and a 160-character command line wraps
              to a different number of lines each time, so as a permanent
              fixture it moved everything under it several times a second. The
              two facts a wedged transfer is diagnosed from are "which command"
              and "what did it last print"; they belong together, and the
              disclosure opens itself on exactly the operations where they are
              the finding. */}
          {view.command !== null && (
            <p className="remote-activity__command">{view.command}</p>
          )}
          <pre
            className="remote-activity__output"
            aria-label="Recent Git output"
          >
            {view.output.length > 0
              ? view.output.join("\n")
              : view.settled === null
                ? "Git has produced no output yet."
                : "Git produced no output."}
          </pre>
        </details>
      )}

      <div className="remote-activity__actions">
        {/* aria-disabled, never `disabled` (styles/AGENTS.md): Chromium blurs
            an element the moment it becomes disabled, and this card is an
            interactive tooltip whose blur handler schedules its own dismissal
            — so `disabled` would take the status off screen at the instant
            the user asked to stop, and drop keyboard focus to <body>
            (SC 2.4.3). The handler guards instead. */}
        {canceling !== null && operationId !== null && (
          <button
            className="remote-activity__button remote-activity__button--stop"
            type="button"
            onClick={() => {
              if (canceling) return;
              void dispatch("remote:cancelActivity", { operationId });
            }}
            aria-disabled={canceling}
            // Where Tab from the trigger lands, ahead of the ✕ that precedes
            // it in the header. Someone tabbing into a card about a fetch that
            // has said nothing for five minutes came for the way to stop it,
            // not the way to stop looking at it. A settled card marks nothing,
            // so the ✕ is first there — which is right, because by then
            // dismissing is the only thing left to do.
            data-focus-first=""
          >
            {canceling ? "Stopping…" : "Cancel"}
          </button>
        )}
        <button
          className="remote-activity__button"
          type="button"
          {...hoverTooltip(tip, "Open the Logs window")}
          onClick={() => void dispatch("logs:openWindow", undefined)}
        >
          Logs
        </button>
        <button
          className="remote-activity__button"
          type="button"
          {...hoverTooltip(tip, "Copy this status and the full Git output")}
          onClick={() => void copyReport()}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {/* A failure is read, not glanced at, and the gesture that ends it
            should be as deliberate as the reading. The ✕ above is the quiet
            exit; this is the one a user looking for "I'm done with this"
            finds without hunting in the corner. */}
        {onClose !== undefined && view.settled === "error" && (
          <button
            className="remote-activity__button"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        )}
      </div>
      {tip.tooltipNode}
    </div>
  );
}

/**
 * Whether Git's own output is the thing to read, rather than a detail.
 *
 * Three cases, and they are the three the card exists for: a network phase
 * that has gone quiet (`warn`), an operation that failed, and one the user
 * stopped. A healthy fetch is explained by its step list.
 */
function evidenceEarnsAttention(view: RemoteActivityView): boolean {
  return (
    view.statusTone === "warn" ||
    view.settled === "error" ||
    view.settled === "canceled"
  );
}

/**
 * How full a step's track is drawn.
 *
 * A finished network step reads 100% rather than empty: it transferred, and the
 * row it is on says so. A step that stopped keeps whatever Git last reported,
 * which is nothing once the view has settled — an empty track under "✕
 * Fetching updates" is the honest drawing of a transfer that did not get
 * anywhere.
 */
function stepPercent(step: RemoteActivityStep): number | null {
  if (step.state === "done") return 100;
  return step.percent;
}

/**
 * A progress track whose space exists whether or not there is a number for it.
 *
 * The reserved-but-empty case is the whole point, so it is deliberately NOT a
 * `progressbar` with a made-up value: an assistive technology should hear
 * "running, progress unknown" rather than "0%". The element is presentational
 * until Git supplies a percentage, and the step's own label carries the state
 * either way.
 */
function Track({
  percent,
  label,
  className
}: {
  percent: number | null;
  label: string | null;
  className: string;
}) {
  if (percent === null) {
    return (
      <span className={className} aria-hidden="true">
        <span style={{ width: "0%" }} />
      </span>
    );
  }
  return (
    <span
      className={className}
      role="progressbar"
      aria-label={label ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ width: `${percent}%` }} />
    </span>
  );
}

/** Everything Git wrote, or the empty log of an operation already gone. */
async function fullLog(operationId: string): Promise<string[]> {
  const result = await dispatch("remote:activityLog", { operationId });
  return result.ok && result.value !== null ? result.value.lines : [];
}
