import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ForgeOwner,
  ForkCheckoutPreflight,
  ForkProgress,
  Repo
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { useModal } from "../../lib/useModal";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import {
  defaultForkTarget,
  defaultUpstream,
  forkNameProblem,
  forkTargets,
  FORK_PROGRESS_LABELS,
  needsUpstreamChoice,
  ownerKindLabel
} from "./fork-dialog";
import {
  forkCheckoutAction,
  forkCheckoutLead,
  remoteChanges,
  upstreamAnswerIsCurrent
} from "./fork-checkout-dialog";
import { GitForkIcon } from "./RepoIdentityMarks";

/**
 * Fork the repository this checkout was cloned from, and point the checkout at
 * the fork.
 *
 * Mounted by whatever raised it — the read-only chip in the worktree header,
 * or a push the forge refused — rather than by `App`, because it is about one
 * repository the user is already looking at. `ForkRepoDialog` is the other
 * shape of the same operation: that one starts from a search and ends in a new
 * checkout, this one starts from a checkout and ends where it started.
 */
export function ForkCheckoutDialog({
  profileId,
  repoId,
  repoName,
  /** Why the dialog opened, when something specific raised it. Shown above the
   *  fold so the answer arrives with the question. */
  reason,
  onForked,
  onClose
}: {
  profileId: string;
  repoId: string;
  repoName: string;
  reason?: string;
  onForked: (repo: Repo) => void;
  onClose: () => void;
}) {
  const tip = useViewportTooltip();
  const [preflight, setPreflight] = useState<ForkCheckoutPreflight | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [owners, setOwners] = useState<ForgeOwner[]>([]);
  const [targetOwner, setTargetOwner] = useState<ForgeOwner | null>(null);
  const [forkName, setForkName] = useState("");
  // Preflight costs forge round trips, so the name it is keyed on settles
  // before it re-runs rather than firing on every keystroke.
  const [debouncedForkName, setDebouncedForkName] = useState("");
  const [addUpstream, setAddUpstream] = useState(true);
  const [upstream, setUpstream] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [progress, setProgress] = useState<ForkProgress | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Whether the user has named the fork themselves. Until they have, the
   *  request carries no `targetName` at all and main's own default (the
   *  source's name) is the right guess — the same rule `ForkRepoDialog`
   *  follows, and the reason opening this dialog is one round of forge calls
   *  rather than two: seeding the field from the answer would otherwise settle
   *  into `debouncedForkName` and re-ask the question main just answered. */
  const [forkNameTouched, setForkNameTouched] = useState(false);
  const activeForkIdRef = useRef<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      subscribe("repo:forkProgress", (event) => {
        if (
          event.profileId === profileId &&
          event.operationId === activeForkIdRef.current
        ) {
          setProgress(event.progress);
        }
      }),
    [profileId]
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedForkName(forkName), 300);
    return () => window.clearTimeout(timeout);
  }, [forkName]);

  /**
   * The upstream worth asking main about — which is none of them, until the
   * answer would differ from the one main assumes.
   *
   * `checkoutPreflight` defaults to `origin`'s own repository, and that is the
   * only candidate unless the source is itself a fork. Passing it back anyway
   * would spend a second round of forge calls, on every open, to be told the
   * same thing.
   *
   * `addUpstream` is deliberately not part of it. Folding the checkbox in here
   * makes unchecking "Keep the original" drop the query and re-run the whole
   * preflight — forge round trips spent re-answering a question about the
   * fork, which a checkbox about a remote cannot change.
   */
  const upstreamQuery =
    upstream !== null &&
    upstream.toLowerCase() !== preflight?.origin.nameWithOwner.toLowerCase()
      ? upstream
      : null;

  // One effect for the whole preflight, re-run whenever an input it answers
  // about settles. `busy` is in the guard as well as the deps: a preflight
  // landing mid-fork would repaint the panel the user is watching progress in.
  useEffect(() => {
    if (busy) return undefined;
    let active = true;
    setChecking(true);
    void dispatch("repo:forkCheckoutPreflight", {
      profileId,
      repoId,
      ...(targetOwner === null ? {} : { targetOwner: targetOwner.login }),
      ...(!forkNameTouched || debouncedForkName.trim() === ""
        ? {}
        : { targetName: debouncedForkName.trim() }),
      ...(upstreamQuery === null ? {} : { upstream: upstreamQuery })
    }).then((result) => {
      if (!active) return;
      setChecking(false);
      if (!result.ok) {
        // The answer on screen described a question that has since failed, so
        // it is cleared rather than left standing beside the error — the
        // "Afterwards" list would otherwise keep promising a remote layout
        // nothing has confirmed, and the submit button would stay live.
        setPreflight(null);
        setCheckError(result.error.message);
        return;
      }
      setCheckError(null);
      setPreflight(result.value);
      if (!forkNameTouched) {
        // Both, so the debounce does not fire a second preflight for a name
        // main already assumed.
        setForkName(result.value.fork.target.name);
        setDebouncedForkName(result.value.fork.target.name);
      }
      setUpstream((current) =>
        current === null ? defaultUpstream(result.value.fork) : current
      );
    });
    return () => {
      active = false;
    };
  }, [
    profileId,
    repoId,
    targetOwner,
    forkNameTouched,
    debouncedForkName,
    upstreamQuery,
    busy
  ]);

  // The accounts a fork can land in, from the instance the source lives on.
  const sourceHost = preflight?.fork.source.host;
  const sourceHostname = preflight?.fork.source.hostname;
  useEffect(() => {
    if (sourceHost === undefined || sourceHost === "other") return undefined;
    let active = true;
    void dispatch("repo:forkTargets", {
      host: sourceHost,
      ...(sourceHostname === undefined ? {} : { hostname: sourceHostname })
    }).then((result) => {
      if (!active || !result.ok) return;
      setOwners(result.value);
    });
    return () => {
      active = false;
    };
  }, [sourceHost, sourceHostname]);

  const targets = useMemo(
    () => forkTargets(owners, preflight?.fork.source ?? null),
    [owners, preflight?.fork.source]
  );
  useEffect(() => {
    setTargetOwner((current) =>
      current !== null && targets.some((owner) => owner.login === current.login)
        ? current
        : defaultForkTarget(targets)
    );
  }, [targets]);

  // Escape, the focus trap, and handing focus back to whatever opened this.
  // It refuses while a fork is running, the same answer the backdrop gives.
  const modalRef = useModal<HTMLDivElement>({
    onClose: () => {
      if (!busy) onClose();
    },
    initialFocusRef: nameInputRef
  });

  const action = forkCheckoutAction(preflight);
  const nameProblem = forkNameProblem(forkName, preflight?.fork ?? null);
  const chosenUpstream = addUpstream ? upstream : null;
  // The list is a promise about what will exist afterwards, so it is drawn
  // only while every part of it has been answered about the current choices.
  const changes =
    preflight !== null &&
    action.kind !== "blocked" &&
    nameProblem === null &&
    targetOwner !== null &&
    upstreamAnswerIsCurrent(preflight, chosenUpstream)
      ? remoteChanges({
          preflight,
          target: `${targetOwner.login}/${forkName.trim()}`,
          upstream: chosenUpstream
        })
      : null;

  const submitDisabled =
    busy ||
    preflight === null ||
    action.kind === "blocked" ||
    nameProblem !== null ||
    targetOwner === null;

  const submit = async (): Promise<void> => {
    if (submitDisabled || preflight === null || targetOwner === null) return;
    const operationId = `fork-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeForkIdRef.current = operationId;
    setBusy(true);
    setSubmitError(null);
    setProgress({ phase: "starting", percent: null });
    const result = await dispatch("repo:forkCheckout", {
      operationId,
      profileId,
      repoId,
      targetOwner: targetOwner.login,
      targetOwnerKind: targetOwner.kind,
      targetName: forkName.trim(),
      upstream: chosenUpstream
    });
    activeForkIdRef.current = null;
    setBusy(false);
    setProgress(null);
    setCanceling(false);
    if (!result.ok) {
      setSubmitError(result.error.message);
      return;
    }
    onForked(result.value);
  };

  const cancel = async (): Promise<void> => {
    const operationId = activeForkIdRef.current;
    if (operationId === null) {
      onClose();
      return;
    }
    if (canceling) return;
    setCanceling(true);
    await dispatch("repo:cancelFork", { operationId });
  };

  return (
    <div
      className="overlay-backdrop clone-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="overlay-panel clone-dialog fork-checkout-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Fork ${repoName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="clone-dialog__title">
          <span className="clone-dialog__icon">
            <GitForkIcon size={17} />
          </span>
          <span>
            <strong>Fork {repoName}</strong>
            <small>
              {preflight === null
                ? "Reading this checkout's origin…"
                : forkCheckoutLead(preflight)}
            </small>
          </span>
          <button
            type="button"
            className="clone-dialog__close"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="clone-dialog__body">
          {reason !== undefined && (
            <div className="clone-note fork-checkout-reason">{reason}</div>
          )}
          {checkError !== null && (
            <div className="clone-note clone-note--error">{checkError}</div>
          )}
          {action.kind === "blocked" && (
            <div className="clone-submit-error">{action.message}</div>
          )}
          {action.kind === "adopt" && (
            <div className="fork-existing">
              <GitForkIcon size={14} />
              <span>
                <strong>{preflight?.fork.existing?.nameWithOwner}</strong>
                <small>
                  Your fork already exists — nothing new is created, this
                  checkout is pointed at it.
                </small>
              </span>
            </div>
          )}

          {/* ── Fork into ──────────────────────────────────────── */}
          {action.kind !== "blocked" && (
            <section className="clone-section">
              <label className="clone-label" htmlFor="fork-checkout-name">
                Fork into
                <span className="clone-label__hint">
                  accounts you can create repositories in
                </span>
              </label>
              <div className="clone-protocols">
                {targets.map((owner) => (
                  <button
                    type="button"
                    key={owner.login}
                    disabled={busy}
                    className={`clone-protocol${
                      targetOwner?.login === owner.login ? " is-active" : ""
                    }`}
                    onClick={() => setTargetOwner(owner)}
                  >
                    <strong>{owner.login}</strong>
                    <small>{ownerKindLabel(owner)}</small>
                  </button>
                ))}
                {targets.length === 0 && (
                  <div className="clone-empty">
                    {checking
                      ? "Loading accounts…"
                      : "Sign in to this forge to choose a fork target."}
                  </div>
                )}
              </div>
              <div className="clone-input-wrap fork-name-wrap">
                <span className="fork-name-owner">
                  {targetOwner?.login ?? "…"} /
                </span>
                <input
                  id="fork-checkout-name"
                  ref={nameInputRef}
                  value={forkName}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setForkNameTouched(true);
                    setForkName(event.target.value);
                  }}
                />
                {checking && (
                  <span className="clone-input-status">checking…</span>
                )}
              </div>
              {nameProblem !== null && forkName !== "" && (
                <div className="clone-note clone-note--error">{nameProblem}</div>
              )}
            </section>
          )}

          {/* ── Keep the original ──────────────────────────────── */}
          {action.kind !== "blocked" && (
            <section className="clone-section">
              <div className="clone-label">Keep the original</div>
              <div className="fork-options">
                <label className={`fork-option${addUpstream ? " is-on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={addUpstream}
                    disabled={busy}
                    onChange={(event) => setAddUpstream(event.target.checked)}
                  />
                  <span>
                    <strong>
                      Keep it as{" "}
                      <code>{preflight?.upstreamRemote.name ?? "upstream"}</code>
                    </strong>
                    <small>
                      Fetch and rebase on the original without leaving PwrGit.
                      Turn this off and this checkout forgets where it came
                      from.
                    </small>
                  </span>
                </label>

                {addUpstream && needsUpstreamChoice(preflight?.fork ?? null) && (
                  <div className="fork-upstream">
                    <div className="fork-upstream__lead">
                      {preflight?.origin.nameWithOwner} is itself a fork — which
                      repository should the remote point at?
                    </div>
                    {preflight?.fork.upstreamChoices.map((choice, index) => (
                      <label
                        key={choice.nameWithOwner}
                        className={`fork-upstream__row${
                          upstream === choice.nameWithOwner ? " is-on" : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="fork-checkout-upstream"
                          checked={upstream === choice.nameWithOwner}
                          disabled={busy}
                          onChange={() => setUpstream(choice.nameWithOwner)}
                        />
                        <span>
                          <strong>{choice.nameWithOwner}</strong>
                          <small>
                            {index === 0
                              ? "root repository — the usual answer"
                              : index ===
                                  preflight.fork.upstreamChoices.length - 1
                                ? "where this checkout came from"
                                : "intermediate parent"}
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ── What this changes ──────────────────────────────── */}
          {changes !== null && (
            <section className="clone-section">
              <div className="clone-label">
                Afterwards
                <span className="clone-label__hint">
                  nothing moves on disk; your branches and changes stay put
                </span>
              </div>
              <ul className="fork-remote-plan">
                {changes.map((change) => (
                  <li
                    key={change.remote}
                    className={`fork-remote-plan__row${
                      change.unchanged ? " is-unchanged" : ""
                    }`}
                  >
                    <code className="fork-remote-plan__name">
                      {change.remote}
                    </code>
                    <span className="fork-remote-plan__copy">
                      <strong>{change.nameWithOwner}</strong>
                      <small>{change.note}</small>
                    </span>
                    <code
                      className="fork-remote-plan__url"
                      {...hoverTooltip(tip, change.url)}
                    >
                      {change.url}
                    </code>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {submitError !== null && (
            <div className="clone-submit-error">{submitError}</div>
          )}
        </div>

        {busy && progress !== null && (
          <div className="clone-progress" aria-live="polite">
            <div className="clone-progress__status">
              <strong>{FORK_PROGRESS_LABELS[progress.phase]}</strong>
              {progress.percent !== null && <span>{progress.percent}%</span>}
            </div>
            <div
              className={`clone-progress__track${
                progress.percent === null ? " is-indeterminate" : ""
              }`}
              role="progressbar"
              aria-label={FORK_PROGRESS_LABELS[progress.phase]}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent ?? undefined}
            >
              <span
                style={{
                  width:
                    progress.percent === null
                      ? undefined
                      : `${progress.percent}%`
                }}
              />
            </div>
          </div>
        )}

        <div className="clone-dialog__foot">
          <span className="clone-dialog__spacer" />
          <button
            type="button"
            className="modal__cancel"
            disabled={canceling || progress?.phase === "indexing"}
            onClick={() => void cancel()}
          >
            {canceling
              ? "Canceling…"
              : progress?.phase === "indexing"
                ? "Finishing…"
                : busy
                  ? "Cancel"
                  : "Not now"}
          </button>
          <button
            type="button"
            className="modal__create clone-dialog__submit"
            disabled={submitDisabled}
            onClick={() => void submit()}
          >
            {busy
              ? `${FORK_PROGRESS_LABELS[progress?.phase ?? "starting"]}…`
              : action.label}
          </button>
        </div>
      </div>
      {tip.tooltipNode}
    </div>
  );
}
