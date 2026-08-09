import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CloneCatalog,
  CloneDestination,
  CloneProgress,
  CloneProtocol,
  CloneRepository,
  Profile,
  Repo
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import {
  cloneDestinationLabel,
  cloneRepositoryAtSelection,
  cloneSourceQuery,
  filterCloneDestinations,
  moveCloneSelection,
  unverifiedCloneRepository
} from "./clone-dialog";

const PROTOCOLS: Array<{
  id: CloneProtocol;
  label: string;
  detail: string;
}> = [
  { id: "ssh", label: "SSH", detail: "git@github.com" },
  { id: "https", label: "HTTPS", detail: "https://github.com" },
  { id: "gh_cli", label: "GitHub CLI", detail: "gh repo clone" }
];

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

function protocolDetail(
  protocol: CloneProtocol,
  repository: CloneRepository | null
): string {
  if (repository === null) {
    return (
      PROTOCOLS.find((candidate) => candidate.id === protocol)?.detail ?? ""
    );
  }
  if (protocol === "ssh") return repository.sshUrl;
  if (protocol === "https") return repository.httpsUrl;
  return `gh repo clone ${repository.nameWithOwner}`;
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
  const [destinationQuery, setDestinationQuery] = useState("");
  const [selectedDestination, setSelectedDestination] =
    useState<CloneDestination | null>(null);
  const [destinationSelection, setDestinationSelection] = useState(0);
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

  const parsedSourceQuery = useMemo(
    () => cloneSourceQuery(catalog?.repositories ?? [], sourceQuery),
    [catalog?.repositories, sourceQuery]
  );
  const exactNameWithOwner =
    parsedSourceQuery.kind === "exact"
      ? parsedSourceQuery.nameWithOwner
      : null;
  const catalogMatches =
    parsedSourceQuery.kind === "search" ? parsedSourceQuery.repositories : [];

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
        nameWithOwner: exactNameWithOwner
      }).then((result) => {
        if (!active) return;
        setChecking(false);
        if (result.ok) setCheckedRepository(result.value);
        else if (
          result.error.code === "github_cli_missing" ||
          result.error.code === "github_login_required"
        ) {
          setCheckedRepository(unverifiedCloneRepository(exactNameWithOwner));
        } else {
          setCheckError(result.error.message);
        }
      });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [exactNameWithOwner, profile.id]);

  const sourceResults = useMemo(() => {
    const rows = checkedRepository
      ? [checkedRepository, ...catalogMatches]
      : catalogMatches;
    return rows.filter(
      (repository, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.nameWithOwner.toLowerCase() ===
            repository.nameWithOwner.toLowerCase()
        ) === index
    );
  }, [catalogMatches, checkedRepository]);

  const destinationResults = useMemo(
    () => filterCloneDestinations(destinations, destinationQuery),
    [destinations, destinationQuery]
  );

  useEffect(() => setDestinationSelection(0), [destinationQuery]);

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
      parentPath: destination.path
    });
    activeCloneIdRef.current = null;
    setBusy(false);
    if (result.ok) onCloned(result.value);
    else {
      setCloneProgress(null);
      setSubmitError(result.error.message);
    }
  };

  const ghCliDisabled =
    catalog !== null && (!catalog.github.installed || !catalog.github.loggedIn);

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
                  {catalog.owners.join(" · ")}
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
              {checking && <span className="clone-input-status">checking…</span>}
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
                  {repository.isPrivate && (
                    <span className="clone-chip">private</span>
                  )}
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
              {parsedSourceQuery.kind === "search" &&
                catalog === null &&
                catalogError === null && (
                  <div className="clone-empty">Loading repositories…</div>
                )}
              {catalogError !== null && (
                <div className="clone-empty clone-empty--error">
                  {catalogError}
                </div>
              )}
              {parsedSourceQuery.kind === "exact" &&
                sourceResults.length === 0 &&
                !checking &&
                checkError !== null && (
                  <div className="clone-empty clone-empty--error">
                    {checkError}
                  </div>
                )}
              {parsedSourceQuery.kind === "search" &&
                catalog !== null &&
                sourceResults.length === 0 &&
                !checking && (
                  <div className="clone-empty">
                    {sourceQuery.trim() === ""
                      ? catalog.owners.length === 0
                        ? "Add a default org to this profile or index a repo with a GitHub remote."
                        : "No repositories found for the known owners."
                      : checkError ??
                        `No repositories match “${sourceQuery}”.`}
                  </div>
                )}
            </div>
            {catalog?.warning !== undefined && (
              <div className="clone-note">{catalog.warning}</div>
            )}
          </section>

          <section className="clone-section">
            <div className="clone-label">Clone with</div>
            <div className="clone-protocols">
              {PROTOCOLS.map((candidate) => {
                const disabled = candidate.id === "gh_cli" && ghCliDisabled;
                const detail = protocolDetail(candidate.id, selectedRepository);
                return (
                  <button
                    type="button"
                    key={candidate.id}
                    disabled={busy || disabled}
                    className={`clone-protocol${
                      protocol === candidate.id ? " is-active" : ""
                    }`}
                    title={
                      disabled
                        ? "GitHub CLI must be installed and signed in"
                        : detail
                    }
                    onClick={() => setProtocol(candidate.id)}
                    >
                      <strong>{candidate.label}</strong>
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
                    setDestinationSelection((selection) =>
                      moveCloneSelection(
                        selection,
                        1,
                        destinationResults.length
                      )
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setDestinationSelection((selection) =>
                      moveCloneSelection(
                        selection,
                        -1,
                        destinationResults.length
                      )
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
                  onMouseEnter={() => setDestinationSelection(index)}
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
