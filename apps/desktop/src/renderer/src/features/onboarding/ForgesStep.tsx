import { useCallback, useEffect, useRef, useState } from "react";
import {
  changeRequestPluralLabel,
  FORGE_KINDS,
  forgeInstall,
  forgeProduct,
  type ForgeKind,
  type ForgeStatus
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { copyText } from "../../lib/copyText";
import { currentPlatform } from "../../lib/platform";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { InfoGlyph } from "../../lib/InfoGlyph";
import { tablistKeyHandler } from "../../lib/tablistKeys";
import {
  codeSpans,
  forgeProductState,
  forgeStateSentence,
  signInCommandFor,
  STATE_LABELS,
  type ForgeProductState
} from "../settings/ForgeProductSection";
import { FORGE_RECHECK_MS } from "../settings/useForgeStatuses";

/**
 * Window focus forces a probe, but focus can flicker several times while
 * someone reads a terminal; one forced pass per this window is plenty. Arrival
 * and Re-check are deliberate acts and are never throttled.
 */
const FOCUS_RECHECK_MIN_MS = 5_000;

/** "Copied" is feedback, not a state, and reverts like Settings' does. */
const COPIED_MS = 2_000;

const PANEL_ID = "onboarding-forge-panel";

function needsAction(state: ForgeProductState): boolean {
  return state === "missing" || state === "signedOut";
}

function stateOf(
  forges: readonly ForgeStatus[],
  kind: ForgeKind
): ForgeProductState {
  return forgeProductState(forges.find((f) => f.kind === kind));
}

/**
 * The strip's order: every forge PwrGit found a CLI for, then the ones it did
 * not, each group in registry order. What the reader already has is what they
 * came to confirm; what they lack is the long tail.
 */
export function arrivalOrder(forges: readonly ForgeStatus[]): ForgeKind[] {
  const detected = (kind: ForgeKind) => {
    const state = stateOf(forges, kind);
    return state !== "missing" && state !== "unknown";
  };
  return [
    ...FORGE_KINDS.filter(detected),
    ...FORGE_KINDS.filter((kind) => !detected(kind))
  ];
}

/** The first forge that needs something, or the first chip when none does. */
export function initialSelection(
  order: readonly ForgeKind[],
  forges: readonly ForgeStatus[]
): ForgeKind {
  return (
    order.find((kind) => needsAction(stateOf(forges, kind))) ??
    order[0] ??
    FORGE_KINDS[0]
  );
}

/**
 * Setup › Forges: a strip of every forge with its state, and one panel holding
 * the selected forge's remedy for this machine — the install commands for this
 * OS, or the sign-in command.
 *
 * One panel rather than a card per forge because the step has to fit the
 * smallest window the app allows (600px, so a 552px dialog). Three full cards
 * were 826px, and the registry is built so that a fourth forge is one entry.
 *
 * The commands live in the shared registry (`forgeInstall`), never here, so
 * this step and Settings → Forges cannot disagree about what to run.
 */
export function ForgesStep(props: { forges: ForgeStatus[] | undefined }) {
  const { forges } = props;
  const platform = currentPlatform();
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState<string | undefined>();
  // Taken once per visit, after the arrival probe has answered — the wizard's
  // own snapshot predates it, so sorting on that would file a forge installed
  // since as missing. A chip whose forge changes state later keeps its place,
  // so the strip never shuffles under the pointer; the next arrival sorts it
  // afresh.
  const [arrived, setArrived] = useState(false);
  const [order, setOrder] = useState<ForgeKind[] | null>(null);
  const [selected, setSelected] = useState<ForgeKind | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const lastForcedAt = useRef(Number.NEGATIVE_INFINITY);
  const mounted = useRef(true);
  const chipRefs = useRef<Partial<Record<ForgeKind, HTMLButtonElement>>>({});
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!arrived || order !== null || forges === undefined) return;
    const next = arrivalOrder(forges);
    setOrder(next);
    // A chip picked while the probe ran is the reader's choice; keep it.
    setSelected((picked) => picked ?? initialSelection(next, forges));
  }, [arrived, forges, order]);

  // A forced probe, the same one Settings' Re-check asks for: refreshing the
  // host list makes main retire its cached status and probe again. The answer
  // arrives as `forge:statusChanged`, which the wizard's `useForgeStatuses`
  // already listens to — so all this owns is the "Checking…" in between.
  // A request while one is in flight joins it rather than starting another.
  const recheck = useCallback((): Promise<void> => {
    if (inFlight.current !== null) return inFlight.current;
    lastForcedAt.current = Date.now();
    setChecking(true);
    const running = dispatch("forge:hosts", { refresh: true })
      .then(
        () => undefined,
        // Nothing to say here: the chips keep the last answer they had.
        () => undefined
      )
      .finally(() => {
        inFlight.current = null;
        if (mounted.current) setChecking(false);
      });
    inFlight.current = running;
    return running;
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Arriving at the step is a reason to look too. The wizard's statuses were
    // read once when it opened, and main answers a plain read from cache — for
    // five minutes once any forge is connected — so stepping Back and forward
    // after installing `gh` showed the pre-install answer indefinitely.
    void recheck().then(() => {
      if (mounted.current) setArrived(true);
    });
    // Coming back from the terminal is the moment an install or a sign-in has
    // just happened, so that is when to look — not only on the next tick.
    const onFocus = () => {
      if (Date.now() - lastForcedAt.current < FOCUS_RECHECK_MIN_MS) return;
      void recheck();
    };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      void dispatch("forge:status", undefined).catch(() => {});
    }, FORGE_RECHECK_MS);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [recheck]);

  useEffect(() => {
    if (copied === undefined) return;
    const timer = window.setTimeout(() => setCopied(undefined), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = useCallback((command: string) => {
    void copyText(command)
      .then(() => setCopied(command))
      .catch(() => {});
  }, []);

  const kinds = order ?? [...FORGE_KINDS];
  const current = selected ?? kinds[0] ?? FORGE_KINDS[0];
  const states = kinds.map((kind) => {
    const status = forges?.find((f) => f.kind === kind);
    return { kind, status, state: forgeProductState(status) };
  });

  // Keep the selected chip in view once the registry outgrows the strip.
  // Measured and scrolled by hand: `scrollIntoView` would scroll every
  // ancestor too, the dialog body included.
  useEffect(() => {
    const strip = stripRef.current;
    const chip = chipRefs.current[current];
    if (strip === null || chip === undefined) return;
    const left = chip.offsetLeft - strip.offsetLeft;
    const right = left + chip.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth)
      strip.scrollLeft = right - strip.clientWidth;
  }, [current]);

  const onKeyDown = tablistKeyHandler(kinds, current, (next) => {
    setSelected(next);
    chipRefs.current[next]?.focus();
  });

  const active = states.find((s) => s.kind === current);

  return (
    <div>
      <div className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          Where PwrGit reads pull and merge requests from.
        </h1>
        <p className="onboarding-wizard__sub">
          Optional — without one, PwrGit does everything but show
          change-request state. It reads each forge through that forge&rsquo;s
          own CLI and never asks for a token.
        </p>
      </div>
      {/* One live region for the step, as Settings → Forges has: a sentence
          per chip would announce three times for one probe pass. */}
      <p aria-live="polite" className="a11y-sr-only" role="status">
        {states
          .map(({ kind, state }) => forgeStateSentence(kind, state))
          .filter((line) => line !== null)
          .join(". ")}
      </p>
      <div className="onboarding-wizard__lens-row">
        <div
          ref={stripRef}
          className="onboarding-wizard__lens"
          role="tablist"
          aria-label="Forges"
          onKeyDown={onKeyDown}
        >
          {states.map(({ kind, state }) => {
            const label = forgeProduct(kind).label;
            const word =
              state === "unknown" || (checking && needsAction(state))
                ? "Checking…"
                : STATE_LABELS[state];
            const isCurrent = kind === current;
            return (
              <button
                key={kind}
                type="button"
                role="tab"
                ref={(element) => {
                  if (element === null) delete chipRefs.current[kind];
                  else chipRefs.current[kind] = element;
                }}
                // Roving tab stop: the strip is one stop, arrows move within.
                tabIndex={isCurrent ? 0 : -1}
                aria-selected={isCurrent}
                aria-controls={PANEL_ID}
                aria-label={`${label}: ${word}`}
                className={`onboarding-wizard__lens-chip${isCurrent ? " is-active" : ""}`}
                onClick={() => setSelected(kind)}
              >
                <span
                  className={`onboarding-wizard__forge-dot is-${state}`}
                  aria-hidden="true"
                />
                <span className="onboarding-wizard__lens-name">{label}</span>
                <span className="onboarding-wizard__lens-state">{word}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
          aria-busy={checking}
          aria-disabled={checking}
          onClick={() => void recheck()}
        >
          <RefreshGlyph />
          {checking ? "Checking…" : "Re-check"}
        </button>
      </div>
      <div
        id={PANEL_ID}
        className="onboarding-wizard__panel"
        role="tabpanel"
        aria-label={forgeProduct(current).label}
      >
        {active !== undefined && (
          <ForgePanel
            kind={active.kind}
            status={active.status}
            state={active.state}
            platform={platform}
            copied={copied}
            onCopy={copy}
          />
        )}
      </div>
    </div>
  );
}

function ForgePanel(props: {
  kind: ForgeKind;
  status: ForgeStatus | undefined;
  state: ForgeProductState;
  platform: string;
  copied: string | undefined;
  onCopy: (command: string) => void;
}) {
  const { kind, status, state } = props;
  const product = forgeProduct(kind);
  if (state === "missing") {
    return (
      <InstallSteps
        kind={kind}
        platform={props.platform}
        copied={props.copied}
        onCopy={props.onCopy}
      />
    );
  }
  if (state === "signedOut" && status !== undefined) {
    return (
      <>
        <p className="onboarding-wizard__forge-sentence">
          <code>{product.cli}</code> is installed. Sign in with it — it opens a
          browser or asks for a token, and keeps the credential itself.
        </p>
        <div className="onboarding-wizard__forge-steps">
          <CommandWell
            command={signInCommandFor(status)}
            copied={props.copied}
            onCopy={props.onCopy}
          />
        </div>
        <div className="onboarding-wizard__forge-foot">
          <TerminalHint />
        </div>
      </>
    );
  }
  if (state === "off") {
    return (
      <p className="onboarding-wizard__forge-sentence">
        Every {product.label} host is switched off in Settings › Forges.
      </p>
    );
  }
  if (state === "connected") {
    return (
      <p className="onboarding-wizard__forge-sentence">
        <code>{product.cli}</code> is installed and signed in. PwrGit reads{" "}
        {changeRequestPluralLabel(kind).toLowerCase()} through it.
      </p>
    );
  }
  return (
    <p className="onboarding-wizard__forge-sentence">
      Checking {product.label}…
    </p>
  );
}

/** Said beside a command, which is the only place it means anything. */
function TerminalHint() {
  return (
    <span className="onboarding-wizard__forge-hint">
      Run it in a terminal — PwrGit checks again when you switch back.
    </span>
  );
}

function InstallSteps(props: {
  kind: ForgeKind;
  platform: string;
  copied: string | undefined;
  onCopy: (command: string) => void;
}) {
  const product = forgeProduct(props.kind);
  const install = forgeInstall(props.kind, props.platform);
  const numbered = install.steps.length > 1;
  return (
    <>
      <p className="onboarding-wizard__forge-sentence">
        {install.note === undefined ? (
          <>
            Install {product.label}&rsquo;s CLI, <code>{product.cli}</code>, then
            sign in with it.
          </>
        ) : (
          codeSpans(install.note)
        )}
      </p>
      <div className="onboarding-wizard__forge-steps">
        {install.steps.map((step, index) => (
          <CommandWell
            key={step}
            command={step}
            {...(numbered ? { step: index + 1 } : {})}
            copied={props.copied}
            onCopy={props.onCopy}
          />
        ))}
      </div>
      {/* A fact about this process's PATH, so it belongs to the forge whose
          install needs it, and goes when that forge is found. */}
      {install.relaunchAfterInstall === true && (
        <p className="onboarding-wizard__forge-relaunch">
          <span className="onboarding-wizard__notice-icon" aria-hidden="true">
            <InfoGlyph />
          </span>
          <span>
            <b>
              Reopen PwrGit after installing <code>{product.cli}</code>.
            </b>{" "}
            Windows only gives a new install&rsquo;s PATH to apps started after
            it, so this window cannot see it yet.
          </span>
        </p>
      )}
      <div className="onboarding-wizard__forge-foot">
        {install.via !== undefined && <span>Uses {install.via}.</span>}
        <button
          type="button"
          className="onboarding-wizard__forge-link"
          onClick={() =>
            void dispatch("shell:openExternal", { url: install.guideUrl }).catch(
              () => {}
            )
          }
        >
          {install.guideLabel ?? "Install guide"} ↗
        </button>
        <TerminalHint />
      </div>
    </>
  );
}

function CommandWell(props: {
  command: string;
  step?: number;
  copied: string | undefined;
  onCopy: (command: string) => void;
}) {
  const copied = props.copied === props.command;
  return (
    <div className="onboarding-wizard__well">
      {props.step !== undefined && (
        <span className="onboarding-wizard__well-step" aria-hidden="true">
          {props.step}
        </span>
      )}
      <code className="onboarding-wizard__well-cmd">{props.command}</code>
      <button
        type="button"
        className={`onboarding-wizard__well-copy${copied ? " is-copied" : ""}`}
        aria-label={`Copy ${props.command}`}
        onClick={() => props.onCopy(props.command)}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
