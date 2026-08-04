import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CloneCatalog,
  CloneDestination,
  CloneProtocol,
  CloneRepository,
  Profile,
  Repo
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import {
  cloneDestinationLabel,
  exactGitHubRepository,
  filterCloneDestinations,
  filterCloneRepositories,
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
  const [submitError, setSubmitError] = useState<string | null>(null);
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

  const catalogMatches = useMemo(
    () => filterCloneRepositories(catalog?.repositories ?? [], sourceQuery),
    [catalog?.repositories, sourceQuery]
  );

  useEffect(() => {
    setSourceSelection(0);
    setCheckedRepository(null);
    setCheckError(null);
    const exact = exactGitHubRepository(sourceQuery);
    if (
      catalog === null ||
      exact === null ||
      catalogMatches.some(
        (repository) =>
          repository.nameWithOwner.toLowerCase() === exact.toLowerCase()
      )
    ) {
      setChecking(false);
      return;
    }
    if (!catalog.github.installed || !catalog.github.loggedIn) {
      setChecking(false);
      setCheckedRepository(unverifiedCloneRepository(exact));
      return;
    }

    setChecking(true);
    let active = true;
    const timeout = window.setTimeout(() => {
      void dispatch("repo:checkCloneSource", {
        profileId: profile.id,
        nameWithOwner: exact
      }).then((result) => {
        if (!active) return;
        setChecking(false);
        if (result.ok) setCheckedRepository(result.value);
        else setCheckError(result.error.message);
      });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [catalog, catalogMatches, profile.id, sourceQuery]);

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
    () =>
      filterCloneDestinations(catalog?.destinations ?? [], destinationQuery),
    [catalog?.destinations, destinationQuery]
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
    setBusy(true);
    setSubmitError(null);
    const result = await dispatch("repo:clone", {
      profileId: profile.id,
      nameWithOwner: selectedRepository.nameWithOwner,
      protocol,
      parentPath: destination.path
    });
    setBusy(false);
    if (result.ok) onCloned(result.value);
    else setSubmitError(result.error.message);
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
                    const repository = sourceResults[sourceSelection];
                    if (repository !== undefined) {
                      event.preventDefault();
                      chooseRepository(repository);
                    }
                  } else if (event.key === "Tab" && !event.shiftKey) {
                    const repository =
                      selectedRepository ?? sourceResults[sourceSelection];
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
              {catalog === null && catalogError === null && (
                <div className="clone-empty">Loading repositories…</div>
              )}
              {catalogError !== null && (
                <div className="clone-empty clone-empty--error">
                  {catalogError}
                </div>
              )}
              {catalog !== null && sourceResults.length === 0 && !checking && (
                <div className="clone-empty">
                  {sourceQuery.trim() === ""
                    ? catalog.owners.length === 0
                      ? "Add a default org to this profile or index a repo with a GitHub remote."
                      : "No repositories found for the known owners."
                    : checkError ?? `No repositories match “${sourceQuery}”.`}
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
              {catalog !== null && catalog.destinations.length === 0 && (
                <div className="clone-empty">
                  Add a repo folder to this profile before cloning.
                </div>
              )}
              {catalog !== null &&
                catalog.destinations.length > 0 &&
                destinationResults.length === 0 && (
                  <div className="clone-empty">
                    No checkout folders match “{destinationQuery}”.
                  </div>
                )}
            </div>
          </section>

          {submitError !== null && (
            <div className="clone-submit-error">{submitError}</div>
          )}
        </div>

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
            {busy ? "Cloning…" : "Clone repository"}
          </button>
        </div>
      </div>
    </div>
  );
}
