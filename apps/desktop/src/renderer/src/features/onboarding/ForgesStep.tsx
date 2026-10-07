import { useCallback, useEffect, useRef, useState } from "react";
import {
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
import {
  codeSpans,
  forgeProductState,
  forgeStateSentence,
  signInCommandFor,
  type ForgeProductState
} from "../settings/ForgeProductSection";

/**
 * How often the step asks main to re-examine its probe while it is open — the
 * same tick Settings → Forges runs. Main answers from cache until its own TTL
 * (a minute for a forge nobody can read) says to probe, so most ticks spawn
 * nothing; without one, a terminal-side install never reaches this step.
 */
const RECHECK_MS = 30_000;

/** "Copied" is feedback, not a state, and reverts like Settings' does. */
const COPIED_MS = 2_000;

const CHIP_LABELS: Record<Exclude<ForgeProductState, "unknown">, string> = {
  missing: "Not installed",
  signedOut: "Signed out",
  off: "Off",
  connected: "Connected"
};

/**
 * Setup › Forges: each product's state, and the one thing that unblocks it on
 * this machine — the install commands for this OS, or the sign-in command.
 *
 * The commands live in the shared registry (`forgeInstall`), never here, so
 * this step and Settings → Forges cannot disagree about what to run.
 */
export function ForgesStep(props: { forges: ForgeStatus[] | undefined }) {
  const { forges } = props;
  const platform = currentPlatform();
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState<string | undefined>();
  const checkingRef = useRef(false);
  const mounted = useRef(true);

  // A forced probe, the same one Settings' Re-check asks for: refreshing the
  // host list makes main retire its cached status and probe again. The answer
  // arrives as `forge:statusChanged`, which the wizard's `useForgeStatuses`
  // already listens to — so all this owns is the "Checking…" in between.
  const recheck = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      await dispatch("forge:hosts", { refresh: true });
    } catch {
      // Nothing to say here: the rows keep the last answer they had.
    } finally {
      checkingRef.current = false;
      if (mounted.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Arriving at the step is a reason to look too. The wizard's statuses were
    // read once when it opened, and main answers a plain read from cache — for
    // five minutes once any forge is connected — so stepping Back and forward
    // after installing `gh` showed the pre-install answer indefinitely.
    void recheck();
    // Coming back from the terminal is the moment an install or a sign-in has
    // just happened, so that is when to look — not only on the next tick.
    const onFocus = () => void recheck();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      void dispatch("forge:status", undefined).catch(() => {});
    }, RECHECK_MS);
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

  const states = FORGE_KINDS.map((kind) => {
    const status = forges?.find((f) => f.kind === kind);
    return { kind, status, state: forgeProductState(status) };
  });
  // Only while a winget product is still missing: it is a fact about this
  // process's PATH, and once nothing needs it, it is noise.
  const relaunchFor = states
    .filter(
      ({ kind, state }) =>
        state === "missing" &&
        forgeInstall(kind, platform).relaunchAfterInstall === true
    )
    .map(({ kind }) => forgeProduct(kind).cli);

  return (
    <div>
      <div className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          Where PwrGit reads pull and merge requests from.
        </h1>
        <p className="onboarding-wizard__sub">
          Optional. Without a forge, PwrGit still finds, branches, commits and
          pushes — you just will not see change-request state on a row. PwrGit
          reads through each forge&rsquo;s own CLI; it never asks for a token.
        </p>
      </div>
      {/* One live region for the step, as Settings → Forges has: a chip per
          row would announce three times for one probe pass. */}
      <p aria-live="polite" className="a11y-sr-only" role="status">
        {states
          .map(({ kind, state }) => forgeStateSentence(kind, state))
          .filter((line) => line !== null)
          .join(". ")}
      </p>
      <div className="onboarding-wizard__forges">
        {states.map(({ kind, status, state }) => (
          <ForgeRow
            key={kind}
            kind={kind}
            status={status}
            state={state}
            platform={platform}
            checking={checking}
            copied={copied}
            onCopy={copy}
          />
        ))}
      </div>
      {relaunchFor.length > 0 && (
        <div className="onboarding-wizard__notice">
          <span className="onboarding-wizard__notice-icon" aria-hidden="true">
            <InfoGlyph />
          </span>
          <div>
            <b>
              Reopen PwrGit after installing{" "}
              {relaunchFor.map((cli, i) => (
                <span key={cli}>
                  {i > 0 ? " or " : ""}
                  <code>{cli}</code>
                </span>
              ))}
              .
            </b>{" "}
            Windows only gives a new install&rsquo;s PATH to apps started after
            it, so this window cannot see it yet.
          </div>
        </div>
      )}
      <div className="onboarding-wizard__recheck">
        <p className="onboarding-wizard__hint">
          Run these in a terminal. PwrGit checks again when you switch back to
          this window. All of it lives in Settings › Forges afterwards.
        </p>
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
    </div>
  );
}

function ForgeRow(props: {
  kind: ForgeKind;
  status: ForgeStatus | undefined;
  state: ForgeProductState;
  platform: string;
  checking: boolean;
  copied: string | undefined;
  onCopy: (command: string) => void;
}) {
  const { kind, status, state, platform } = props;
  const product = forgeProduct(kind);
  // A blocked row is the one a re-check might move; a connected one keeps its
  // chip, so nothing that is fine flickers when the window regains focus.
  const showChecking =
    props.checking && (state === "missing" || state === "signedOut");
  const chip =
    state === "unknown" || showChecking
      ? { tone: "pending", label: "Checking…" }
      : { tone: state, label: CHIP_LABELS[state] };

  return (
    <div className="onboarding-wizard__forge">
      <span
        className={`onboarding-wizard__forge-dot is-${state}`}
        aria-hidden="true"
      />
      <div className="onboarding-wizard__forge-main">
        <div className="onboarding-wizard__forge-head">
          <span className="onboarding-wizard__forge-name">{product.label}</span>
          <span className={`onboarding-wizard__forge-chip is-${chip.tone}`}>
            {chip.label}
          </span>
        </div>
        {state === "missing" && (
          <InstallSteps
            kind={kind}
            platform={platform}
            copied={props.copied}
            onCopy={props.onCopy}
          />
        )}
        {state === "signedOut" && status !== undefined && (
          <>
            <p className="onboarding-wizard__forge-sentence">
              <code>{product.cli}</code> is installed. Sign in with it — it opens
              a browser or asks for a token, and keeps the credential itself.
            </p>
            <div className="onboarding-wizard__forge-steps">
              <CommandWell
                command={signInCommandFor(status)}
                copied={props.copied}
                onCopy={props.onCopy}
              />
            </div>
          </>
        )}
        {state === "off" && (
          <p className="onboarding-wizard__forge-sentence">
            Every {product.label} host is switched off in Settings › Forges.
          </p>
        )}
        {state === "connected" && (
          <p className="onboarding-wizard__forge-sentence">
            <code>{product.cli}</code> is installed and signed in.
          </p>
        )}
      </div>
    </div>
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
