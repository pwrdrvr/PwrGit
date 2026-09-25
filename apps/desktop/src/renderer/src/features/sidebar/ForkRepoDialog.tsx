import { useEffect, useMemo, useRef, useState } from "react";
import {
  forgeLabel,
  forgeProductOrAssumed,
  isForgeKind,
  type CloneDestination,
  type CloneCatalog,
  type CloneProtocol,
  type CloneRepository,
  type ForgeKind,
  type ForgeOwner,
  type ForkPreflight,
  type ForkProgress,
  type Profile,
  type Repo
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { useForgeHostMap } from "../../lib/useForgeHostMap";
import { useModal } from "../../lib/useModal";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
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
  statusFor,
  forgeCanAnswerAnywhere,
  forgeCanAnswerDialog
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
  initialSource,
  inPlace,
  onForked,
  onReveal,
  onClose
}: {
  profile: Profile;
  /** A repository to open on, instead of an empty search box — the one the
   *  sidebar had selected when Fork… was pressed. Pressing a button labelled
   *  Fork and being asked what to fork is the gap this closes. Preflight
   *  upgrades it the same way it upgrades a pasted slug, so an identity-shaped
   *  placeholder is enough. */
  initialSource?: CloneRepository;
  /** The checkout `initialSource` was read from. Forking that repository
   *  does not need a second clone: `ForkCheckoutDialog` forks it and points
   *  the existing checkout at the fork. This dialog cannot do that itself, so
   *  it offers the way there while the source is still that repository. */
  inPlace?: { repoName: string; onChoose: () => void };
  onForked: (repo: Repo) => void;
  onReveal: (path: string) => void;
  onClose: () => void;
}) {
  const tip = useViewportTooltip();
  /** The card for one destination row. Named so the row's own `onMouseEnter`
   *  can call it rather than overwrite it — see the call site. */
  const destinationTip = (destination: CloneDestination) =>
    hoverTooltip(tip, destination.path);
  const [catalog, setCatalog] = useState<CloneCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<CloneDestination[]>([]);
  const [destinationsLoading, setDestinationsLoading] = useState(true);
  const [sourceQuery, setSourceQuery] = useState(
    initialSource?.nameWithOwner ?? ""
  );
  const [sourceSelection, setSourceSelection] = useState(0);
  const [host, setHost] = useState<ForgeKind>(
    // The seed's own forge, so the picker does not open on a tab that cannot
    // fork it. `other` is not a ForgeKind and falls back like an empty open.
    initialSource !== undefined && isForgeKind(initialSource.host)
      ? initialSource.host
      : "github"
  );
  const [selectedSource, setSelectedSource] = useState<CloneRepository | null>(
    initialSource ?? null
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

  // Escape, the focus trap, and handing focus back to whatever opened this —
  // the contract ForkCheckoutDialog already had. It refuses while a fork is
  // running, the same answer the backdrop gives. Without it Tab walked off the
  // footer into the window behind the dialog (SC 2.4.3), and Escape worked only
  // from the two search fields, each of which called onClose itself.
  const modalRef = useModal<HTMLDivElement>({
    onClose: () => {
      if (!busy) onClose();
    },
    initialFocusRef: sourceInputRef
  });

  useEffect(() => {
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
    .filter((status) => forgeCanAnswerAnywhere(status))
    .map((status) => status.kind);

  useEffect(() => {
    if (usableHosts.length === 0 || usableHosts.includes(host)) return;
    setHost(usableHosts[0]!);
    // And drop a selection that belonged to the forge we just left. Before the
    // dialog could be seeded this effect had nothing to contradict — it only
    // ever ran with `selectedSource` still null. A seed makes the correction
    // reachable with a source already in hand, and leaving it would produce
    // exactly the state `selectHost` clears state to prevent: the picker
    // reading GITLAB while the targets, preflight and upstream all describe a
    // GitHub repository.
    setSelectedSource(null);
    setPreflight(null);
    // Catalog loading can finish after the user starts typing. Only discard
    // the old selection's label; preserve a new search for the usable forge.
    setSourceQuery((query) =>
      query === selectedSource?.nameWithOwner ? "" : query
    );
  }, [usableHosts.join(","), host, selectedSource]);

  // Fork targets follow the forge actually in play, not the catalog: they are
  // the signed-in user's own accounts, which the clone catalog has no reason
  // to know. Keyed on the *source's* forge once one is chosen — a pasted URL
  // may name a different forge than the picker, and fetching for the picker
  // then filtering by the source left the list empty.
  const ownersHost = selectedSource?.host ?? host;
  // Resolved to an instance up front rather than left null until a source is
  // picked. Null-then-`github.com` is the SAME instance spelled two ways, and
  // it re-ran this effect on the first selection of any SaaS repository — for
  // an identical provider, since the registry pre-seeds the SaaS entry. The
  // `setForkOwners([])` below then emptied the owner picker, which nulled the
  // fork target, which re-ran preflight twice more: eight `gh` spawns and a
  // spurious "Sign in with the gh CLI to choose a fork target."
  const ownersHostname =
    selectedSource?.hostname ??
    (ownersHost === "other" ? null : defaultHostname(ownersHost));
  useEffect(() => {
    if (ownersHost === "other") {
      setForkOwners([]);
      return;
    }
    let active = true;
    setForkOwners([]);
    void dispatch("repo:forkTargets", {
      host: ownersHost,
      // A fork lands on the instance the source lives on, so the accounts
      // offered must come from there — without the hostname main lists the
      // user's github.com/gitlab.com orgs for an Enterprise source.
      ...(ownersHostname === null ? {} : { hostname: ownersHostname })
    }).then((result) => {
      if (active && result.ok) setForkOwners(result.value);
    });
    return () => {
      active = false;
    };
  }, [ownersHost, ownersHostname]);

  // A pasted URL names its own instance, but only main knows which forge runs
  // there — see `useForgeHostMap`. Without the list a self-managed host reads
  // as `other`, which has no provider to fork with.
  const forgeHosts = useForgeHostMap();
  const exact = useMemo(
    () => exactRepository(sourceQuery, host, forgeHosts),
    [sourceQuery, host, forgeHosts]
  );

  // Debounced, and only on what was typed. The catalog this replaced listed
  // every known owner's repositories when the dialog opened — one CLI round
  // trip per account, before the user had touched the box.
  const search = useCloneSearch({
    profileId: profile.id,
    query: sourceQuery,
    host,
    // Nothing to search for while the box already names the chosen source.
    // That is every keystroke-free moment after a pick — and, now that the
    // dialog can open seeded, the whole of a seeded open: searching there
    // spent a forge round trip re-finding the repository the user had just
    // come from, and `exactRepository` then listed an `unknown`-visibility
    // duplicate of it beneath the real one.
    enabled:
      usableHosts.includes(host) &&
      (selectedSource === null || sourceQuery !== selectedSource.nameWithOwner)
  });

  useEffect(() => setSourceSelection(0), [sourceQuery]);

  // What preflight is actually keyed on. Strings, deliberately: the effect
  // writes its own answer back into `selectedSource` (to upgrade an
  // unverified placeholder), and an IPC response is a fresh object every
  // time — depending on the object itself made the effect re-trigger itself
  // for as long as the dialog stayed open, two forge calls per lap.
  const preflightSource = selectedSource?.nameWithOwner ?? null;
  const preflightHost = selectedSource?.host ?? null;
  const preflightHostname = selectedSource?.hostname ?? null;
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
      // Without the instance, a self-managed source is preflighted against the
      // forge's SaaS host — reporting a different repository's fork state, and
      // then creating the fork there.
      ...(preflightHostname === null ? {} : { hostname: preflightHostname }),
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
    preflightHostname,
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
        ref={modalRef}
        tabIndex={-1}
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
                      {forgeLabel(candidate)}
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
            {/* Only while the source is still the seed. Search for something
                else and the checkout this names is no longer the one being
                forked. `nameWithOwner` and `hostname` because a same-named
                project on another instance is a different repository. */}
            {inPlace !== undefined &&
              initialSource !== undefined &&
              selectedSource !== null &&
              selectedSource.hostname === initialSource.hostname &&
              selectedSource.nameWithOwner.toLowerCase() ===
                initialSource.nameWithOwner.toLowerCase() && (
                <div className="fork-in-place">
                  <span>
                    <strong>Already checked out here, as {inPlace.repoName}</strong>
                    <small>
                      Forking in place keeps this checkout: origin moves to your
                      fork and the original stays as upstream. Nothing new is
                      cloned.
                    </small>
                  </span>
                  <button
                    type="button"
                    className="modal__cancel fork-in-place__action"
                    disabled={busy}
                    onClick={inPlace.onChoose}
                  >
                    Fork in place…
                  </button>
                </div>
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
                      Fetch and rebase on the original without leaving PwrGit.{" "}
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
                        {/* The CLI is the source host's, not a literal: this
                            block is gated on the `forkDefaultBranchOnly`
                            capability, never on a kind, so any product that
                            sets it would otherwise be shown GitHub's command. */}
                        <code>
                          {forgeProductOrAssumed(sourceHost).cli} repo fork
                          --default-branch-only
                        </code>
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
                  const slug =
                    preflight?.target.nameWithOwner ??
                    selectedSource?.nameWithOwner ??
                    "owner/name";
                  const hostname =
                    selectedSource?.hostname ?? defaultHostname(sourceHost);
                  // The instance this fork would actually run against, so an
                  // Enterprise-only sign-in is not told its CLI cannot answer.
                  const disabled =
                    candidate === "cli" &&
                    !forgeCanAnswerDialog(forgeStatus, hostname);
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
                      /* See CloneRepoDialog: the unavailable reason goes in
                         the name as well as the card, and `detail` stays a
                         card because it ellipsises. */
                      aria-label={
                        disabled
                          ? `${cliLabel.label} — unavailable, ${cliLabel.label} must be installed and signed in`
                          : undefined
                      }
                      {...hoverTooltip(
                        tip,
                        disabled
                          ? `${cliLabel.label} must be installed and signed in`
                          : detail
                      )}
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
                    /* The full path as the option's NAME, where the row's own
                       text is a `root/relative/` label whose basename repeats
                       across registered roots. That ambiguity was why the path
                       was sitting in a `title` — an attribute no screen reader
                       reads off a named button, and no keyboard user can open. */
                    aria-label={`${destination.path} — ${destinationMeta(destination)}`}
                    {...destinationTip(destination)}
                    // See CloneRepoDialog: merged, not spread over, because a
                    // later `onMouseEnter` would silently win.
                    onMouseEnter={(event) => {
                      setDestinationSelectionPath(destination.path);
                      tip.show(event.currentTarget, destination.path);
                    }}
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
      {tip.tooltipNode}
    </div>
  );
}
