import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CloneDestination,
  CloneCatalog,
  CloneProtocol,
  CloneRepository,
  ForgeKind,
  ForgeOwner,
  ForkPreflight,
  ForkProgress,
  Profile,
  Repo
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { useCloneSearch } from "./useCloneSearch";
import {
  cloneDestinationLabel,
  cloneDestinationSelectionIndex,
  cloneRepositoryAtSelection,
  defaultHostname,
  exactRepository,
  filterCloneDestinations,
  moveCloneSelection,
  rankCloneRepositories
} from "./clone-dialog";
import {
  cliProtocolLabel,
  defaultForkTarget,
  defaultUpstream,
  forkAction,
  forkNameProblem,
  forkTargets,
  FORK_PROGRESS_LABELS,
  needsUpstreamChoice,
  ownerKindLabel,
  supportsDefaultBranchOnly,
  repositoriesOnHost,
  sourceEmptyMessage,
  statusFor
} from "./fork-dialog";
import { GitForkIcon, RepoIdentityChips } from "./RepoIdentityMarks";

function destinationMeta(destination: CloneDestination): string {
  if (destination.lastUsedAt !== undefined) return "recent";
  if (destination.relativePath === "") return "registered root";
  return `${destination.repoCount} ${
    destination.repoCount === 1 ? "repo" : "repos"
  }`;
}

export function ForkRepoDialog({
  profile,
  onForked,
  onReveal,
  onClose
}: {
  profile: Profile;
  onForked: (repo: Repo) => void;
  onReveal: (path: string) => void;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<CloneCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<CloneDestination[]>([]);
  const [destinationsLoading, setDestinationsLoading] = useState(true);
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceSelection, setSourceSelection] = useState(0);
  const [host, setHost] = useState<ForgeKind>("github");
  const [selectedSource, setSelectedSource] = useState<CloneRepository | null>(
    null
  );
  const [preflight, setPreflight] = useState<ForkPreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [targetOwner, setTargetOwner] = useState<ForgeOwner | null>(null);
  const [forkOwners, setForkOwners] = useState<ForgeOwner[]>([]);
  const [forkName, setForkName] = useState("");
  const [forkNameTouched, setForkNameTouched] = useState(false);
  // Preflight costs two forge round trips, so the name it is keyed on settles
  // before it re-runs rather than firing on every keystroke.
  const [debouncedForkName, setDebouncedForkName] = useState("");
  const [addUpstream, setAddUpstream] = useState(true);
  const [upstream, setUpstream] = useState<string | null>(null);
  const [defaultBranchOnly, setDefaultBranchOnly] = useState(false);
  const [protocol, setProtocol] = useState<CloneProtocol>("ssh");
  const [destinationQuery, setDestinationQuery] = useState("");
  const [selectedDestination, setSelectedDestination] =
    useState<CloneDestination | null>(null);
  const [destinationSelectionPath, setDestinationSelectionPath] = useState<
    string | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [progress, setProgress] = useState<ForkProgress | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const activeForkIdRef = useRef<string | null>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const destinationInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    sourceInputRef.current?.focus();
    let active = true;
    void dispatch("repo:cloneCatalog", { profileId: profile.id }).then(
      (result) => {
        if (!active) return;
        if (result.ok) setCatalog(result.value);
        else setCatalogError(result.error.message);
      }
    );
    return () => {
      active = false;
    };
  }, [profile.id]);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedForkName(forkName),
      300
    );
    return () => window.clearTimeout(timeout);
  }, [forkName]);

  useEffect(
    () =>
      subscribe("repo:forkProgress", (event) => {
        if (
          event.profileId === profile.id &&
          event.operationId === activeForkIdRef.current
        ) {
          setProgress(event.progress);
        }
      }),
    [profile.id]
  );

  useEffect(() => {
    let active = true;
    setDestinationsLoading(true);
    void dispatch("repo:cloneDestinations", {
      profileId: profile.id,
      includeNested: true
    }).then((result) => {
      if (!active) return;
      setDestinationsLoading(false);
      if (result.ok) setDestinations(result.value);
    });
    return () => {
      active = false;
    };
  }, [profile.id]);

  const forges = catalog?.forges ?? [];
  // Only forges whose CLI is actually usable are offered — a host toggle that
  // leads straight to "install the CLI" is a dead end presented as a choice.
  const usableHosts = forges
    .filter((status) => status.installed && status.loggedIn)
    .map((status) => status.kind);

  useEffect(() => {
    if (usableHosts.length > 0 && !usableHosts.includes(host)) {
      setHost(usableHosts[0]!);
    }
  }, [usableHosts.join(","), host]);

  // Fork targets follow the forge actually in play, not the catalog: they are
  // the signed-in user's own accounts, which the clone catalog has no reason
  // to know. Keyed on the *source's* forge once one is chosen — a pasted URL
  // may name a different forge than the picker, and fetching for the picker
  // then filtering by the source left the list empty.
  const ownersHost = selectedSource?.host ?? host;
  useEffect(() => {
    if (ownersHost === "other") {
      setForkOwners([]);
      return;
    }
    let active = true;
    setForkOwners([]);
    void dispatch("repo:forkTargets", { host: ownersHost }).then((result) => {
      if (active && result.ok) setForkOwners(result.value);
    });
    return () => {
      active = false;
    };
  }, [ownersHost]);

  const exact = useMemo(
    () => exactRepository(sourceQuery, host),
    [sourceQuery, host]
  );

  // Debounced, and only on what was typed. The catalog this replaced listed
  // every known owner's repositories when the dialog opened — one CLI round
  // trip per account, before the user had touched the box.
  const search = useCloneSearch({
    profileId: profile.id,
    query: sourceQuery,
    host,
    enabled: usableHosts.includes(host)
  });

  useEffect(() => setSourceSelection(0), [sourceQuery]);

  // What preflight is actually keyed on. Strings, deliberately: the effect
  // writes its own answer back into `selectedSource` (to upgrade an
  // unverified placeholder), and an IPC response is a fresh object every
  // time — depending on the object itself made the effect re-trigger itself
  // for as long as the dialog stayed open, two forge calls per lap.
  const preflightSource = selectedSource?.nameWithOwner ?? null;
  const preflightHost = selectedSource?.host ?? null;
  const preflightTargetName =
    forkNameTouched && debouncedForkName.trim() !== ""
      ? debouncedForkName.trim()
      : null;

  // Preflight runs on the *chosen* source, not on every keystroke: it costs
  // two forge round trips, and its answers only matter once a source is real.
  useEffect(() => {
    if (selectedSource === null) {
      setPreflight(null);
      setCheckError(null);
      return;
    }
    setChecking(true);
    setCheckError(null);
    let active = true;
    void dispatch("repo:forkPreflight", {
      profileId: profile.id,
      source: selectedSource.nameWithOwner,
      host: selectedSource.host,
      ...(targetOwner === null ? {} : { targetOwner: targetOwner.login }),
      // Only once the user has actually named it: before that the service's
      // default (the source's name) is the right guess, and sending an empty
      // string mid-edit would probe a nonexistent repository.
      ...(preflightTargetName === null
        ? {}
        : { targetName: preflightTargetName })
    }).then((result) => {
      if (!active) return;
      setChecking(false);
      if (result.ok) {
        setPreflight(result.value);
        // A slug typed rather than picked from a catalog was selected as an
        // `unknown` placeholder. Preflight has since read the real thing, so
        // the row stops claiming PwrGit could not determine what it just read.
        if (result.value.blocked?.code === undefined) {
          setSelectedSource((current) =>
            current !== null &&
            current.nameWithOwner === result.value.source.nameWithOwner
              ? result.value.source
              : current
          );
        }
        if (!forkNameTouched) {
          setForkName(result.value.target.name);
          setDebouncedForkName(result.value.target.name);
        }
        setUpstream(defaultUpstream(result.value));
      } else {
        setPreflight(null);
        setCheckError(result.error.message);
      }
    });
    return () => {
      active = false;
    };
  }, [
    preflightSource,
    preflightHost,
    preflightTargetName,
    targetOwner?.login,
    profile.id
  ]);

  const targets = useMemo(
    () => forkTargets(forkOwners, selectedSource, host),
    [forkOwners, selectedSource, host]
  );
  useEffect(() => {
    if (targetOwner === null || !targets.some((o) => o.login === targetOwner.login)) {
      setTargetOwner(defaultForkTarget(targets));
    }
  }, [targets.map((o) => o.login).join(","), targetOwner?.login]);

  const sourceResults = useMemo(() => {
    // Results can span forges when a pasted URL names one; the picker's tab is
    // what may be forked into, so anything else would offer a fork that cannot
    // be created.
    const rows = rankCloneRepositories(
      repositoriesOnHost(search.repositories, host),
      sourceQuery
    );
    if (exact !== null && !rows.some((r) => r.nameWithOwner === exact.nameWithOwner)) {
      rows.unshift({
        name: exact.nameWithOwner.slice(exact.nameWithOwner.lastIndexOf("/") + 1),
        owner: exact.nameWithOwner.slice(0, exact.nameWithOwner.lastIndexOf("/")),
        nameWithOwner: exact.nameWithOwner,
        visibility: "unknown",
        host: exact.host,
        hostname: exact.hostname,
        sshUrl: "",
        httpsUrl: "",
        localPaths: []
      });
    }
    return rows;
  }, [search.repositories, host, sourceQuery, exact?.nameWithOwner, exact?.host]);

  const destinationResults = useMemo(
    () => filterCloneDestinations(destinations, destinationQuery),
    [destinations, destinationQuery]
  );
  const destinationSelection = cloneDestinationSelectionIndex(
    destinationResults,
    destinationSelectionPath
  );
  const activeDestination =
    selectedDestination ?? destinationResults[destinationSelection] ?? null;

  const action = forkAction(preflight);
  const nameProblem = forkNameProblem(forkName, preflight);
  const sourceHost = selectedSource?.host ?? host;
  const forgeStatus = statusFor(forges, sourceHost);
  const cliLabel = cliProtocolLabel(sourceHost);
  // Read from the forge's reported capability, not a hardcoded host name.
  const defaultBranchOnlySupported = supportsDefaultBranchOnly(forgeStatus);

  /** Switching forge abandons the selection, because it belonged to the other
   *  one. Keeping it left the picker claiming GITLAB while the targets, URLs
   *  and upstream all still described a GitHub repository. */
  const selectHost = (candidate: ForgeKind): void => {
    if (candidate === host) return;
    setHost(candidate);
    setSelectedSource(null);
    setPreflight(null);
    setCheckError(null);
    setSourceQuery("");
    setForkName("");
    setDebouncedForkName("");
    setForkNameTouched(false);
    setSubmitError(null);
  };

  const chooseSource = (repository: CloneRepository): void => {
    // A pasted URL names its own forge, which may not be the one the picker
    // shows. Follow the selection rather than leaving the two disagreeing —
    // set `host` directly, not through `selectHost`, which clears the
    // selection by design.
    if (repository.host !== "other" && repository.host !== host) {
      setHost(repository.host);
    }
    setSelectedSource(repository);
    setSourceQuery(repository.nameWithOwner);
    setForkNameTouched(false);
    setSubmitError(null);
    window.requestAnimationFrame(() => destinationInputRef.current?.focus());
  };

  const submit = async (): Promise<void> => {
    if (action.kind === "reveal_existing") {
      onReveal(action.path);
      return;
    }
    if (
      selectedSource === null ||
      activeDestination === null ||
      busy ||
      action.kind === "blocked" ||
      nameProblem !== null ||
      targetOwner === null
    ) {
      return;
    }
    const operationId = window.crypto.randomUUID();
    activeForkIdRef.current = operationId;
    setBusy(true);
    setCanceling(false);
    setProgress({ phase: "starting", percent: null });
    setSubmitError(null);
    const result = await dispatch("repo:fork", {
      operationId,
      profileId: profile.id,
      source: selectedSource.nameWithOwner,
      host: selectedSource.host,
      hostname: selectedSource.hostname,
      targetOwner: targetOwner.login,
      targetOwnerKind: targetOwner.kind,
      targetName: forkName,
      protocol,
      parentPath: activeDestination.path,
      defaultBranchOnly: defaultBranchOnly && defaultBranchOnlySupported,
      upstream: addUpstream ? upstream : null
    });
    activeForkIdRef.current = null;
    setBusy(false);
    setCanceling(false);
    if (result.ok) onForked(result.value);
    else {
      setProgress(null);
      setSubmitError(result.error.message);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!busy) {
      onClose();
      return;
    }
    const operationId = activeForkIdRef.current;
    if (operationId === null || canceling) return;
    setCanceling(true);
    await dispatch("repo:cancelFork", { operationId });
  };

  const submitDisabled =
    busy ||
    selectedSource === null ||
    activeDestination === null ||
    action.kind === "blocked" ||
    (action.kind !== "reveal_existing" &&
      (nameProblem !== null || targetOwner === null));

  return (
    <div
      className="overlay-backdrop clone-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="overlay-panel clone-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Fork a repository"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="clone-dialog__title">
          <span className="clone-dialog__icon">
            <GitForkIcon size={17} />
          </span>
          <span>
            <strong>Fork a repository</strong>
            <small>
              Create your own copy, then check it out in {profile.name}
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
          {/* ── Source ─────────────────────────────────────────── */}
          <section className="clone-section">
            <label className="clone-label" htmlFor="fork-source">
              Repository to fork
              {usableHosts.length > 1 && (
                <span className="fork-hosts" role="group" aria-label="Forge">
                  {usableHosts.map((candidate) => (
                    <button
                      type="button"
                      key={candidate}
                      className={`fork-host${host === candidate ? " is-active" : ""}`}
                      aria-pressed={host === candidate}
                      disabled={busy}
                      onClick={() => selectHost(candidate)}
                    >
                      {candidate === "gitlab" ? "GitLab" : "GitHub"}
                    </button>
                  ))}
                </span>
              )}
            </label>
            <div className="clone-input-wrap">
              <GitForkIcon size={17} />
              <input
                id="fork-source"
                ref={sourceInputRef}
                value={sourceQuery}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                placeholder="Search repositories or enter owner/name…"
                onChange={(event) => {
                  setSourceQuery(event.target.value);
                  setSelectedSource(null);
                  setSubmitError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSourceSelection((selection) =>
                      moveCloneSelection(selection, 1, sourceResults.length)
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSourceSelection((selection) =>
                      moveCloneSelection(selection, -1, sourceResults.length)
                    );
                  } else if (event.key === "Enter") {
                    const repository = cloneRepositoryAtSelection(
                      sourceResults,
                      sourceSelection
                    );
                    if (repository !== undefined) {
                      event.preventDefault();
                      chooseSource(repository);
                    }
                  } else if (event.key === "Escape") {
                    onClose();
                  }
                }}
              />
              {checking && <span className="clone-input-status">checking…</span>}
            </div>

            <div className="clone-source-results" role="listbox">
              {sourceResults.map((repository, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === sourceSelection}
                  key={`${repository.host}:${repository.nameWithOwner}`}
                  className={`clone-source-row${
                    index === sourceSelection ? " is-selected" : ""
                  }${
                    selectedSource?.nameWithOwner === repository.nameWithOwner
                      ? " is-picked"
                      : ""
                  }`}
                  disabled={busy}
                  onMouseEnter={() => setSourceSelection(index)}
                  onClick={() => chooseSource(repository)}
                >
                  <span className="clone-source-row__mark" />
                  <span className="clone-source-row__copy">
                    <strong>{repository.nameWithOwner}</strong>
                    <small>{repository.description ?? "Repository"}</small>
                  </span>
                  <RepoIdentityChips repository={repository} />
                </button>
              ))}
              {/* Loading is NOT "unavailable" — see sourceEmptyMessage. The
                  wording lives there so it is covered by a test rather than
                  only by whoever next opens this dialog. */}
              {sourceResults.length === 0 && !checking && (
                <div
                  className={`clone-empty${
                    catalogError === null ? "" : " clone-empty--error"
                  }`}
                >
                  {sourceEmptyMessage({
                    catalogLoaded: catalog !== null,
                    catalogError,
                    status: forgeStatus,
                    cliLabel: cliLabel.label,
                    query: sourceQuery,
                    searching: search.searching,
                    searchError: search.error,
                    owners: (catalog?.owners ?? [])
                      .filter((owner) => owner.host === host)
                      .map((owner) => owner.login)
                  })}
                </div>
              )}
            </div>
            {checkError !== null && (
              <div className="clone-note clone-note--error">{checkError}</div>
            )}
            {action.kind === "blocked" && (
              <div className="clone-submit-error">{action.message}</div>
            )}
            {preflight?.existing !== undefined &&
              action.kind !== "blocked" && (
                <div className="fork-existing">
                  <GitForkIcon size={14} />
                  <span>
                    <strong>{preflight.existing.nameWithOwner}</strong>
                    <small>
                      {action.kind === "reveal_existing"
                        ? `Your fork is already checked out at ${action.path}`
                        : "Your fork already exists — this will clone it."}
                    </small>
                  </span>
                </div>
              )}
          </section>

          {/* ── Fork into ──────────────────────────────────────── */}
          {action.kind === "fork" && (
            <section className="clone-section">
              <label className="clone-label" htmlFor="fork-name">
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
                    {catalog === null
                      ? "Loading accounts…"
                      : `Sign in with the ${cliLabel.label} to choose a fork target.`}
                  </div>
                )}
              </div>
              <div className="clone-input-wrap fork-name-wrap">
                <span className="fork-name-owner">
                  {targetOwner?.login ?? "…"} /
                </span>
                <input
                  id="fork-name"
                  value={forkName}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setForkNameTouched(true);
                    setForkName(event.target.value);
                  }}
                />
                {nameProblem === null && forkName !== "" && (
                  <span className="fork-name-ok">name is free</span>
                )}
              </div>
              {nameProblem !== null && forkName !== "" && (
                <div className="clone-note clone-note--error">{nameProblem}</div>
              )}
            </section>
          )}

          {/* ── After forking ──────────────────────────────────── */}
          {action.kind === "fork" && (
            <section className="clone-section">
              <div className="clone-label">After forking</div>
              <div className="fork-options">
                <label
                  className={`fork-option${addUpstream ? " is-on" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={addUpstream}
                    disabled={busy}
                    onChange={(event) => setAddUpstream(event.target.checked)}
                  />
                  <span>
                    <strong>
                      Add an <code>upstream</code> remote
                      {upstream !== null && (
                        <>
                          {" → "}
                          <code className="fork-option__target">{upstream}</code>
                        </>
                      )}
                    </strong>
                    <small>
                      Fetch and rebase on the original without leaving PwrGit.
                      <code>origin</code> stays your fork.
                    </small>
                  </span>
                </label>

                {addUpstream && needsUpstreamChoice(preflight) && (
                  <div className="fork-upstream">
                    <div className="fork-upstream__lead">
                      {selectedSource?.nameWithOwner} is itself a fork — which
                      repository should <code>upstream</code> point at?
                    </div>
                    {preflight?.upstreamChoices.map((choice, index) => (
                      <label
                        key={choice.nameWithOwner}
                        className={`fork-upstream__row${
                          upstream === choice.nameWithOwner ? " is-on" : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="fork-upstream"
                          checked={upstream === choice.nameWithOwner}
                          disabled={busy}
                          onChange={() => setUpstream(choice.nameWithOwner)}
                        />
                        <span>
                          <strong>{choice.nameWithOwner}</strong>
                          <small>
                            {index === 0
                              ? "root repository — the usual answer"
                              : index === preflight.upstreamChoices.length - 1
                                ? "the repository you picked"
                                : "intermediate parent"}
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                )}

                {defaultBranchOnlySupported && (
                  <label
                    className={`fork-option${defaultBranchOnly ? " is-on" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={defaultBranchOnly}
                      disabled={busy}
                      onChange={(event) =>
                        setDefaultBranchOnly(event.target.checked)
                      }
                    />
                    <span>
                      <strong>Copy the default branch only</strong>
                      <small>
                        A smaller fork —{" "}
                        <code>gh repo fork --default-branch-only</code>
                      </small>
                    </span>
                  </label>
                )}
              </div>
            </section>
          )}

          {/* ── Clone with ─────────────────────────────────────── */}
          {action.kind !== "reveal_existing" && (
            <section className="clone-section">
              <div className="clone-label">Clone with</div>
              <div className="clone-protocols">
                {(["ssh", "https", "cli"] as const).map((candidate) => {
                  const disabled =
                    candidate === "cli" &&
                    (forgeStatus?.installed !== true || !forgeStatus.loggedIn);
                  const slug =
                    preflight?.target.nameWithOwner ??
                    selectedSource?.nameWithOwner ??
                    "owner/name";
                  const hostname =
                    selectedSource?.hostname ?? defaultHostname(sourceHost);
                  const detail =
                    candidate === "ssh"
                      ? `git@${hostname}:${slug}.git`
                      : candidate === "https"
                        ? `https://${hostname}/${slug}.git`
                        : cliLabel.detail(slug);
                  return (
                    <button
                      type="button"
                      key={candidate}
                      disabled={busy || disabled}
                      className={`clone-protocol${
                        protocol === candidate ? " is-active" : ""
                      }`}
                      title={
                        disabled
                          ? `${cliLabel.label} must be installed and signed in`
                          : detail
                      }
                      onClick={() => setProtocol(candidate)}
                    >
                      <strong>
                        {candidate === "ssh"
                          ? "SSH"
                          : candidate === "https"
                            ? "HTTPS"
                            : cliLabel.label}
                      </strong>
                      <small>{detail}</small>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* ── Destination ────────────────────────────────────── */}
          {action.kind !== "reveal_existing" && (
            <section className="clone-section">
              <label className="clone-label" htmlFor="fork-destination">
                Check out to
                <span className="clone-label__hint">
                  inside a registered repo folder
                </span>
              </label>
              <div className="clone-input-wrap">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 7h6l2 2h10v10H3z" />
                </svg>
                <input
                  id="fork-destination"
                  ref={destinationInputRef}
                  value={destinationQuery}
                  disabled={busy || selectedSource === null}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Type to find a root or nested prefix…"
                  onChange={(event) => {
                    setDestinationQuery(event.target.value);
                    setSelectedDestination(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      const selection = moveCloneSelection(
                        destinationSelection,
                        1,
                        destinationResults.length
                      );
                      setDestinationSelectionPath(
                        destinationResults[selection]?.path ?? null
                      );
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      const selection = moveCloneSelection(
                        destinationSelection,
                        -1,
                        destinationResults.length
                      );
                      setDestinationSelectionPath(
                        destinationResults[selection]?.path ?? null
                      );
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      void submit();
                    } else if (event.key === "Escape") {
                      onClose();
                    }
                  }}
                />
                {destinationsLoading && (
                  <span className="clone-input-status">finding folders…</span>
                )}
              </div>
              <div className="clone-destination-results" role="listbox">
                {destinationResults.map((destination, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === destinationSelection}
                    key={destination.path}
                    className={`clone-destination-row${
                      index === destinationSelection ? " is-selected" : ""
                    }${
                      selectedDestination?.path === destination.path
                        ? " is-picked"
                        : ""
                    }`}
                    disabled={busy || selectedSource === null}
                    title={destination.path}
                    onMouseEnter={() =>
                      setDestinationSelectionPath(destination.path)
                    }
                    onClick={() => {
                      setSelectedDestination(destination);
                      setDestinationQuery(cloneDestinationLabel(destination));
                    }}
                  >
                    <span className="clone-destination-row__path">
                      {cloneDestinationLabel(destination)}
                    </span>
                    <span className="clone-destination-row__meta">
                      {destinationMeta(destination)}
                    </span>
                  </button>
                ))}
                {!destinationsLoading && destinations.length === 0 && (
                  <div className="clone-empty">
                    Add a repo folder to this profile before forking.
                  </div>
                )}
              </div>
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
            <div className="clone-progress__metrics">
              {progress.bytesReceived !== undefined && (
                <span>{progress.bytesReceived} transferred</span>
              )}
              {progress.transferRate !== undefined && (
                <span>{progress.transferRate}</span>
              )}
            </div>
          </div>
        )}

        <div className="clone-dialog__foot">
          <span>↑↓ navigate</span>
          <span>↵ select / fork</span>
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
                : "Cancel"}
          </button>
          <button
            type="button"
            className="modal__create clone-dialog__submit"
            disabled={submitDisabled}
            onClick={() => void submit()}
          >
            {busy && typeof progress?.percent === "number"
              ? `${FORK_PROGRESS_LABELS[progress.phase]} ${progress.percent}%…`
              : busy
                ? `${FORK_PROGRESS_LABELS[progress?.phase ?? "starting"]}…`
                : action.label}
          </button>
        </div>
      </div>
    </div>
  );
}
