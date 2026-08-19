import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CloneCatalog,
  CloneDestination,
  CloneProgress,
  CloneProtocol,
  CloneRepository,
  ForgeHost,
  ForgeKind,
  Profile,
  Repo
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import {
  cloneDestinationLabel,
  cloneDestinationSelectionIndex,
  cloneRepositoryAtSelection,
  defaultHostname,
  exactRepository,
  filterCloneDestinations,
  moveCloneSelection,
  rankCloneRepositories,
  unverifiedCloneRepository
} from "./clone-dialog";
import {
  cliProtocolLabel,
  sourceEmptyMessage,
  statusFor
} from "./fork-dialog";
import { useCloneSearch } from "./useCloneSearch";
import { RepoIdentityChips } from "./RepoIdentityMarks";

const PROTOCOL_IDS = ["ssh", "https", "cli"] as const;

function CloneIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function destinationMeta(destination: CloneDestination): string {
  if (destination.lastUsedAt !== undefined) return "recent";
  if (destination.relativePath === "") return "registered root";
  return `${destination.repoCount} ${
    destination.repoCount === 1 ? "repo" : "repos"
  }`;
}

function protocolLabel(protocol: CloneProtocol, host: ForgeHost): string {
  if (protocol === "ssh") return "SSH";
  if (protocol === "https") return "HTTPS";
  return cliProtocolLabel(host).label;
}

function protocolDetail(
  protocol: CloneProtocol,
  repository: CloneRepository | null,
  host: ForgeHost
): string {
  const hostname = repository?.hostname ?? defaultHostname(host);
  if (repository === null) {
    if (protocol === "ssh") return `git@${hostname}`;
    if (protocol === "https") return `https://${hostname}`;
    return cliProtocolLabel(host).detail("owner/name");
  }
  if (protocol === "ssh") return repository.sshUrl;
  if (protocol === "https") return repository.httpsUrl;
  return cliProtocolLabel(repository.host).detail(repository.nameWithOwner);
}

const CLONE_PROGRESS_LABELS: Record<CloneProgress["phase"], string> = {
  starting: "Preparing clone",
  counting: "Counting objects",
  compressing: "Compressing objects",
  receiving: "Receiving objects",
  resolving: "Resolving deltas",
  checking_out: "Checking out files",
  indexing: "Adding repository to PwrGit"
};

export function CloneRepoDialog({
  profile,
  onCloned,
  onClose
}: {
  profile: Profile;
  onCloned: (repo: Repo) => void;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<CloneCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<CloneDestination[]>([]);
  const [destinationsLoading, setDestinationsLoading] = useState(true);
  const [destinationsError, setDestinationsError] = useState<string | null>(
    null
  );
  const [sourceQuery, setSourceQuery] = useState("");
  const [selectedRepository, setSelectedRepository] =
    useState<CloneRepository | null>(null);
  const [checkedRepository, setCheckedRepository] =
    useState<CloneRepository | null>(null);
  const [sourceSelection, setSourceSelection] = useState(0);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<CloneProtocol>("ssh");
  const [host, setHost] = useState<ForgeKind>("github");
  const [destinationQuery, setDestinationQuery] = useState("");
  const [selectedDestination, setSelectedDestination] =
    useState<CloneDestination | null>(null);
  const [destinationSelectionPath, setDestinationSelectionPath] = useState<
    string | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [cloneProgress, setCloneProgress] = useState<CloneProgress | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const activeCloneIdRef = useRef<string | null>(null);
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

  useEffect(
    () =>
      subscribe("repo:cloneProgress", (event) => {
        if (
          event.profileId === profile.id &&
          event.operationId === activeCloneIdRef.current
        ) {
          setCloneProgress(event.progress);
        }
      }),
    [profile.id]
  );

  useEffect(() => {
    let active = true;
    let expansionFrame: number | null = null;
    setDestinations([]);
    setDestinationsLoading(true);
    setDestinationsError(null);

    const loadExpanded = (): void => {
      void dispatch("repo:cloneDestinations", {
        profileId: profile.id,
        includeNested: true
      }).then((result) => {
        if (!active) return;
        setDestinationsLoading(false);
        if (result.ok) {
          setDestinations(result.value);
          setDestinationsError(null);
        } else {
          setDestinationsError(result.error.message);
        }
      });
    };

    void dispatch("repo:cloneDestinations", {
      profileId: profile.id,
      includeNested: false
    }).then((result) => {
      if (!active) return;
      if (result.ok) setDestinations(result.value);
      else setDestinationsError(result.error.message);

      // Let the priority results paint before the broader prefix scan begins.
      expansionFrame = window.requestAnimationFrame(loadExpanded);
    });

    return () => {
      active = false;
      if (expansionFrame !== null) {
        window.cancelAnimationFrame(expansionFrame);
      }
    };
  }, [profile.id]);

  const exactRepo = useMemo(
    () => exactRepository(sourceQuery, host),
    [sourceQuery, host]
  );
  const exactNameWithOwner = exactRepo?.nameWithOwner ?? null;

  // The host toggle only offers forges whose CLI can actually answer; a
  // toggle that leads straight to "install the CLI" is a dead end dressed up
  // as a choice.
  const usableHosts = (catalog?.forges ?? [])
    .filter((status) => status.installed && status.loggedIn)
    .map((status) => status.kind);
  // Snap onto a forge that can actually answer. Without this a machine with
  // only GitLab signed in leaves `host` on its "github" default forever: the
  // search is disabled, and the toggle that would fix it is not rendered
  // because there is only one usable host to offer.
  useEffect(() => {
    if (usableHosts.length > 0 && !usableHosts.includes(host)) {
      setHost(usableHosts[0]!);
    }
  }, [usableHosts.join(","), host]);

  const activeHost = selectedRepository?.host ?? host;
  const forgeStatus = statusFor(catalog?.forges ?? [], activeHost);
  const cliDisabled =
    catalog !== null &&
    (forgeStatus?.installed !== true || !forgeStatus.loggedIn);

  // Nothing is asked of the forge until the box settles — and never on open.
  // The catalog this replaced listed every known owner's repositories up
  // front, which is one CLI round trip per account before the first paint.
  const search = useCloneSearch({
    profileId: profile.id,
    query: sourceQuery,
    host,
    enabled: usableHosts.includes(host)
  });

  useEffect(() => setSourceSelection(0), [sourceQuery]);

  useEffect(() => {
    setCheckedRepository(null);
    setCheckError(null);
    if (exactNameWithOwner === null) {
      setChecking(false);
      return;
    }

    setChecking(true);
    let active = true;
    const timeout = window.setTimeout(() => {
      void dispatch("repo:checkCloneSource", {
        profileId: profile.id,
        nameWithOwner: exactNameWithOwner,
        host: exactRepo?.host ?? host
      }).then((result) => {
        if (!active) return;
        setChecking(false);
        if (result.ok) setCheckedRepository(result.value);
        else if (
          result.error.code === "forge_cli_missing" ||
          result.error.code === "forge_login_required"
        ) {
          setCheckedRepository(
            unverifiedCloneRepository(exactNameWithOwner, exactRepo?.host ?? host)
          );
        } else {
          setCheckError(result.error.message);
        }
      });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [exactNameWithOwner, exactRepo?.host, host, profile.id]);

  const sourceResults = useMemo(() => {
    // Filtered to the picked forge: a host switch keeps the previous results
    // on screen through the debounce and round trip, and without this the
    // GitLab tab spends that second listing GitHub repositories.
    const ranked = rankCloneRepositories(
      search.repositories.filter((repository) => repository.host === host),
      sourceQuery
    );
    const rows = checkedRepository ? [checkedRepository, ...ranked] : ranked;
    return rows.filter(
      (repository, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.nameWithOwner.toLowerCase() ===
            repository.nameWithOwner.toLowerCase()
        ) === index
    );
  }, [search.repositories, host, sourceQuery, checkedRepository]);

  // One line for every reason the list is empty, so the states cannot
  // contradict each other. `checkError` wins over a bare "no matches": when
  // the box holds an exact slug, why THAT lookup failed is the useful answer.
  const emptyMessage =
    checkError ??
    sourceEmptyMessage({
      catalogLoaded: catalog !== null,
      catalogError,
      status: forgeStatus,
      cliLabel: cliProtocolLabel(activeHost).label,
      query: sourceQuery,
      searching: search.searching,
      searchError: search.error,
      owners: (catalog?.owners ?? [])
        .filter((owner) => owner.host === host)
        .map((owner) => owner.login)
    });

  const destinationResults = useMemo(
    () => filterCloneDestinations(destinations, destinationQuery),
    [destinations, destinationQuery]
  );
  const destinationSelection = cloneDestinationSelectionIndex(
    destinationResults,
    destinationSelectionPath
  );

  useEffect(() => setDestinationSelectionPath(null), [destinationQuery]);

  const chooseRepository = (repository: CloneRepository): void => {
    setSelectedRepository(repository);
    setSourceQuery(repository.nameWithOwner);
    setSubmitError(null);
    window.requestAnimationFrame(() => destinationInputRef.current?.focus());
  };

  const activeDestination =
    selectedDestination ?? destinationResults[destinationSelection] ?? null;

  const submit = async (destination = activeDestination): Promise<void> => {
    if (selectedRepository === null || destination === null || busy) return;
    const operationId = window.crypto.randomUUID();
    activeCloneIdRef.current = operationId;
    setBusy(true);
    setCloneProgress({ phase: "starting", percent: null });
    setSubmitError(null);
    const result = await dispatch("repo:clone", {
      operationId,
      profileId: profile.id,
      nameWithOwner: selectedRepository.nameWithOwner,
      protocol,
      parentPath: destination.path,
      host: selectedRepository.host,
      hostname: selectedRepository.hostname
    });
    activeCloneIdRef.current = null;
    setBusy(false);
    if (result.ok) onCloned(result.value);
    else {
      setCloneProgress(null);
      setSubmitError(result.error.message);
    }
  };

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
        aria-label="Clone a repository"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="clone-dialog__title">
          <span className="clone-dialog__icon">
            <CloneIcon />
          </span>
          <span>
            <strong>Clone a repository</strong>
            <small>
              Find GitHub repos from owners already used in {profile.name}
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
          <section className="clone-section">
            <label className="clone-label" htmlFor="clone-source">
              Repository
              {catalog !== null && catalog.owners.length > 0 && (
                <span className="clone-label__hint">
                  {catalog.owners.map((owner) => owner.login).join(" · ")}
                </span>
              )}
              {usableHosts.length > 1 && (
                <span className="fork-hosts" role="group" aria-label="Forge">
                  {usableHosts.map((candidate) => (
                    <button
                      type="button"
                      key={candidate}
                      className={`fork-host${host === candidate ? " is-active" : ""}`}
                      aria-pressed={host === candidate}
                      disabled={busy}
                      onClick={() => setHost(candidate)}
                    >
                      {candidate === "gitlab" ? "GitLab" : "GitHub"}
                    </button>
                  ))}
                </span>
              )}
            </label>
            <div className="clone-input-wrap">
              <CloneIcon />
              <input
                id="clone-source"
                ref={sourceInputRef}
                value={sourceQuery}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                placeholder="Search repositories or enter owner/name…"
                onChange={(event) => {
                  setSourceQuery(event.target.value);
                  setSelectedRepository(null);
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
                      chooseRepository(repository);
                    }
                  } else if (event.key === "Tab" && !event.shiftKey) {
                    const repository =
                      selectedRepository ??
                      cloneRepositoryAtSelection(
                        sourceResults,
                        sourceSelection
                      );
                    if (repository !== undefined) {
                      event.preventDefault();
                      chooseRepository(repository);
                    }
                  } else if (event.key === "Escape") {
                    onClose();
                  }
                }}
              />
              {(checking || search.searching) && (
                <span className="clone-input-status">
                  {checking ? "checking…" : "searching…"}
                </span>
              )}
            </div>

            <div className="clone-source-results" role="listbox">
              {sourceResults.map((repository, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === sourceSelection}
                  key={repository.nameWithOwner}
                  className={`clone-source-row${
                    index === sourceSelection ? " is-selected" : ""
                  }${
                    selectedRepository?.nameWithOwner === repository.nameWithOwner
                      ? " is-picked"
                      : ""
                  }`}
                  disabled={busy}
                  onMouseEnter={() => setSourceSelection(index)}
                  onClick={() => chooseRepository(repository)}
                >
                  <span className="clone-source-row__mark" />
                  <span className="clone-source-row__copy">
                    <strong>{repository.nameWithOwner}</strong>
                    <small>{repository.description ?? "GitHub repository"}</small>
                  </span>
                  <RepoIdentityChips repository={repository} />
                  {repository.localPaths.length > 0 && (
                    <span
                      className="clone-chip clone-chip--muted"
                      title={repository.localPaths.join("\n")}
                    >
                      cloned
                    </span>
                  )}
                </button>
              ))}
              {sourceResults.length === 0 && !checking && emptyMessage !== null && (
                <div
                  className={`clone-empty${
                    catalogError ?? checkError ?? search.error
                      ? " clone-empty--error"
                      : ""
                  }`}
                >
                  {emptyMessage}
                </div>
              )}
            </div>
          </section>

          <section className="clone-section">
            <div className="clone-label">Clone with</div>
            <div className="clone-protocols">
              {PROTOCOL_IDS.map((candidate) => {
                const disabled = candidate === "cli" && cliDisabled;
                const detail = protocolDetail(
                  candidate,
                  selectedRepository,
                  activeHost
                );
                const label = protocolLabel(candidate, activeHost);
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
                        ? `${label} must be installed and signed in`
                        : detail
                    }
                    onClick={() => setProtocol(candidate)}
                  >
                    <strong>{label}</strong>
                    <small>{detail}</small>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="clone-section">
            <label className="clone-label" htmlFor="clone-destination">
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
                id="clone-destination"
                ref={destinationInputRef}
                value={destinationQuery}
                disabled={busy || selectedRepository === null}
                autoComplete="off"
                spellCheck={false}
                placeholder="Type to find a root or nested prefix…"
                onChange={(event) => {
                  setDestinationQuery(event.target.value);
                  setSelectedDestination(null);
                  setSubmitError(null);
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
                    const destination =
                      selectedDestination ??
                      destinationResults[destinationSelection];
                    if (destination !== undefined) {
                      event.preventDefault();
                      void submit(destination);
                    }
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
                  disabled={busy || selectedRepository === null}
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
              {destinationsError !== null && destinations.length === 0 && (
                <div className="clone-empty clone-empty--error">
                  {destinationsError}
                </div>
              )}
              {!destinationsLoading &&
                destinationsError === null &&
                destinations.length === 0 && (
                  <div className="clone-empty">
                    Add a repo folder to this profile before cloning.
                  </div>
                )}
              {!destinationsLoading &&
                destinations.length > 0 &&
                destinationResults.length === 0 && (
                  <div className="clone-empty">
                    No checkout folders match “{destinationQuery}”.
                  </div>
              )}
              {destinationsLoading && (
                <div className="clone-destination-progress" role="status">
                  <span className="clone-destination-progress__dot" />
                  Finding more checkout folders…
                </div>
              )}
            </div>
          </section>

          {submitError !== null && (
            <div className="clone-submit-error">{submitError}</div>
          )}
        </div>

        {busy && cloneProgress !== null && (
          <div className="clone-progress" aria-live="polite">
            <div className="clone-progress__status">
              <strong>{CLONE_PROGRESS_LABELS[cloneProgress.phase]}</strong>
              {cloneProgress.percent !== null && (
                <span>{cloneProgress.percent}%</span>
              )}
            </div>
            <div
              className={`clone-progress__track${
                cloneProgress.percent === null ? " is-indeterminate" : ""
              }`}
              role="progressbar"
              aria-label={CLONE_PROGRESS_LABELS[cloneProgress.phase]}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={cloneProgress.percent ?? undefined}
            >
              <span
                style={{
                  width:
                    cloneProgress.percent === null
                      ? undefined
                      : `${cloneProgress.percent}%`
                }}
              />
            </div>
            <div className="clone-progress__metrics">
              {cloneProgress.bytesReceived !== undefined && (
                <span>{cloneProgress.bytesReceived} transferred</span>
              )}
              {cloneProgress.bytesReceived === undefined &&
                cloneProgress.completedObjects !== undefined &&
                cloneProgress.totalObjects !== undefined && (
                  <span>
                    {cloneProgress.completedObjects.toLocaleString()} /{" "}
                    {cloneProgress.totalObjects.toLocaleString()} objects
                  </span>
                )}
              {cloneProgress.transferRate !== undefined && (
                <span>{cloneProgress.transferRate}</span>
              )}
            </div>
          </div>
        )}

        <div className="clone-dialog__foot">
          <span>↑↓ navigate</span>
          <span>tab next field</span>
          <span>↵ select / clone</span>
          <span className="clone-dialog__spacer" />
          <button
            type="button"
            className="modal__cancel"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal__create clone-dialog__submit"
            disabled={
              busy || selectedRepository === null || activeDestination === null
            }
            onClick={() => void submit()}
          >
            {busy && typeof cloneProgress?.percent === "number"
              ? `Cloning ${cloneProgress.percent}%…`
              : busy
                ? "Cloning…"
                : "Clone repository"}
          </button>
        </div>
      </div>
    </div>
  );
}
