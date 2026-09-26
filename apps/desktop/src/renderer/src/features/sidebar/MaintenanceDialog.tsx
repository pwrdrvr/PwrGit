import { useEffect, useRef, useState } from "react";
import type {
  GarbageCollectionMode,
  MaintenanceAction,
  MaintenanceRepo,
  MaintenanceRepoResult,
  MaintenanceSummary,
  StaleBranch
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { displayPath } from "../../lib/platform";
import { useModal } from "../../lib/useModal";
import { BulkSyncStatus } from "./BulkSyncStatus";
import { countOutcomes } from "./bulk-sync-progress";

const branchKey = (branch: StaleBranch): string =>
  `${branch.repoId}:${branch.branch}`;
const bytes = (value: number): string => {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024)
    return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
};

export function MaintenanceDialog({
  profileId,
  platform,
  onClose
}: {
  profileId: string;
  platform: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"gc" | "branches">("gc");
  const [mode, setMode] = useState<GarbageCollectionMode>("standard");
  const [allProfiles, setAllProfiles] = useState(false);
  const [action, setAction] = useState<MaintenanceAction | null>(null);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [repos, setRepos] = useState<MaintenanceRepo[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [details, setDetails] = useState<Map<string, string>>(new Map());
  const [results, setResults] = useState<Map<string, MaintenanceRepoResult>>(
    new Map()
  );
  const [summary, setSummary] = useState<MaintenanceSummary | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const active = useRef<string | null>(null);
  const live = useRef(true);
  const offProgress = useRef<(() => void) | null>(null);
  const footerFocus = useRef<HTMLButtonElement>(null);
  const modalRef = useModal<HTMLDivElement>({
    onClose: () => {
      if (!active.current) onClose();
    }
  });

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      offProgress.current?.();
      if (active.current !== null)
        void dispatch("maintenance:cancel", { operationId: active.current });
    };
  }, []);

  useEffect(() => {
    if (action !== null) footerFocus.current?.focus();
  }, [running, action]);

  const reset = (): void => {
    setSummary(null);
    setResults(new Map());
    setDetails(new Map());
    setRepos([]);
    setSelected(new Set());
    setError(null);
    setAction(null);
  };

  const run = async (next: MaintenanceAction): Promise<void> => {
    if (active.current !== null) return;
    const operationId = crypto.randomUUID();
    active.current = operationId;
    setRunning(true);
    setCancelling(false);
    setAction(next);
    setSummary(null);
    setResults(new Map());
    setDetails(new Map());
    setRepos([]);
    setCurrent(null);
    setError(null);
    setSelected(new Set());
    setStartedAt(Date.now());
    offProgress.current = subscribe("maintenance:progress", (event) => {
      if (
        !live.current ||
        event.operationId !== operationId ||
        event.profileId !== profileId
      )
        return;
      if (event.repos !== undefined) setRepos(event.repos);
      if (event.phase === "repo_started") setCurrent(event.repo?.id ?? null);
      if (event.repo !== undefined && event.detail !== undefined) {
        const { repo, detail } = event;
        setDetails((old) => new Map(old).set(repo.id, detail));
      }
      if (event.result !== undefined) {
        const result = event.result;
        setResults((old) => new Map(old).set(result.repo.id, result));
        setCurrent(null);
      }
    });
    try {
      const response = await dispatch("maintenance:run", {
        operationId,
        profileId,
        allProfiles,
        action: next
      });
      if (!live.current) return;
      if (response.ok) {
        setSummary(response.value);
        setRepos(response.value.results.map((result) => result.repo));
        setResults(
          new Map(
            response.value.results.map((result) => [result.repo.id, result])
          )
        );
      } else setError(response.error.message);
    } catch (cause) {
      if (live.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      offProgress.current?.();
      offProgress.current = null;
      active.current = null;
      if (live.current) {
        setRunning(false);
        setCurrent(null);
      }
    }
  };

  const cancel = async (): Promise<void> => {
    if (active.current === null || cancelling) return;
    setCancelling(true);
    try {
      const response = await dispatch("maintenance:cancel", {
        operationId: active.current
      });
      if (!response.ok) {
        setError(response.error.message);
        setCancelling(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCancelling(false);
    }
  };

  const candidates =
    action?.kind === "scan-branches" && summary !== null
      ? summary.results.flatMap((result) => result.candidates ?? [])
      : [];
  const counts = countOutcomes(
    [...results.values()].map((result) => result.outcome)
  );
  const currentRepo = repos.find((repo) => repo.id === current);
  const complete = summary !== null;
  const scanComplete = complete && action?.kind === "scan-branches";
  const toggleBranch = (key: string): void =>
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div
      className="overlay-backdrop bulk-sync-backdrop"
      onClick={running ? undefined : onClose}
    >
      <section
        ref={modalRef}
        tabIndex={-1}
        className="modal bulk-sync maintenance"
        role="dialog"
        aria-modal="true"
        aria-label="Repository maintenance"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="bulk-sync__head">
          <div>
            <h2>Repository maintenance</h2>
            <p>
              Clean up Git storage and review leftover local branches across
              your repositories.
            </p>
          </div>
          {action !== null && (
            <span className="bulk-sync__count">
              {results.size} / {repos.length}
            </span>
          )}
        </div>
        <div
          className="maintenance__tabs"
          role="group"
          aria-label="Maintenance task"
        >
          <button
            aria-pressed={tab === "gc"}
            disabled={running}
            onClick={() => {
              setTab("gc");
              reset();
            }}
          >
            Garbage collection
          </button>
          <button
            aria-pressed={tab === "branches"}
            disabled={running}
            onClick={() => {
              setTab("branches");
              reset();
            }}
          >
            Local branches
          </button>
        </div>
        {(running || complete) && (
          <BulkSyncStatus
            phase={
              running
                ? cancelling
                  ? "cancelling"
                  : "running"
                : summary?.cancelled
                  ? "cancelled"
                  : "finished"
            }
            hasFailures={counts.failed + counts.partial > 0}
            title={
              running
                ? cancelling
                  ? "Stopping after the current repository operation…"
                  : currentRepo
                    ? `${action?.kind === "gc" ? "Collecting" : action?.kind === "scan-branches" ? "Reviewing" : "Cleaning branches in"} ${currentRepo.name}`
                    : "Waiting for the next repository…"
                : summary?.cancelled
                  ? "Cancelled"
                  : "Finished"
            }
            detail={
              running
                ? currentRepo
                  ? {
                      kind: "path",
                      text: displayPath(currentRepo.path, platform)
                    }
                  : null
                : {
                    kind: "summary",
                    text: `${counts.success} succeeded · ${counts.skipped} skipped · ${counts.failed + counts.partial} need attention${scanComplete ? ` · ${candidates.length} eligible branch${candidates.length === 1 ? "" : "es"}` : ""}`
                  }
            }
            counts={counts}
            inFlight={current === null ? 0 : 1}
            queued={Math.max(
              0,
              repos.length - results.size - (current === null ? 0 : 1)
            )}
            startedAt={startedAt}
            durationMs={
              summary === null
                ? null
                : Date.parse(summary.finishedAt) - Date.parse(summary.startedAt)
            }
          />
        )}
        <div className="maintenance__body">
          <label className="maintenance__scope">
            <input
              type="checkbox"
              checked={allProfiles}
              disabled={running}
              onChange={(event) => {
                setAllProfiles(event.target.checked);
                reset();
              }}
            />{" "}
            Include all profiles
          </label>
          <p className="maintenance__help">
            {allProfiles
              ? "Every known repository across all profiles."
              : "Every known repository in this window’s profile."}{" "}
            Shared object stores are processed once per scan or collection.
          </p>
          {tab === "gc" ? (
            <fieldset
              className="maintenance__options"
              disabled={running}
              hidden={action !== null}
            >
              <legend>Garbage collection options</legend>
              <label>
                <input
                  type="radio"
                  name="gc-mode"
                  checked={mode === "standard"}
                  onChange={() => setMode("standard")}
                />
                <span>
                  <strong>Standard (recommended)</strong>
                  <small>
                    <code>git gc</code> repacks objects and expires unused
                    history according to your Git retention settings. Start here
                    for routine cleanup.
                  </small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="gc-mode"
                  checked={mode === "keep-largest"}
                  onChange={() => setMode("keep-largest")}
                />
                <span>
                  <strong>Keep the largest pack</strong>
                  <small>
                    <code>--keep-largest-pack</code> leaves the largest pack
                    intact to reduce repacking work. It may leave more storage
                    in use.
                  </small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="gc-mode"
                  checked={mode === "aggressive"}
                  onChange={() => setMode("aggressive")}
                />
                <span>
                  <strong>Aggressive compression</strong>
                  <small>
                    <code>--aggressive</code> recalculates compression more
                    thoroughly. It can take much longer and use more CPU and
                    memory, with no guaranteed size reduction.
                  </small>
                </span>
              </label>
            </fieldset>
          ) : (
            <div className="maintenance__help" hidden={action !== null}>
              <p>
                <strong>Fetch all repos first.</strong> PwrGit’s regular fetches
                and Fetch all repos already use <code>--prune</code>, removing
                stale remote-tracking references such as{" "}
                <code>origin/feature</code>. Your local <code>feature</code>{" "}
                branch remains.
              </p>
              <p>
                Review finds local branches whose remote upstream is missing and
                whose commits are already in the repository checkout’s current
                HEAD. Checked-out branches, common main branches, and known
                remote default branches are retained. Branches with no upstream,
                unique commits, or unproven squash merges are also retained.
              </p>
              <p>
                Choose the branches to delete after review. Each is checked
                again before ordinary, non-force deletion. This does not delete
                anything on a remote.
              </p>
            </div>
          )}
          {tab === "gc" && action === null && (
            <details className="maintenance__help">
              <summary>What gets cleaned up?</summary>
              <p>
                Pack files compress commits, file contents, and directory
                information. Repacking reorganizes them; pruning expires
                unreachable objects. Files in retained history still take space
                even if you deleted them in a later commit.
              </p>
              <p>
                Git normally runs some maintenance automatically. PwrGit runs
                collection in the foreground, one repository at a time, and
                preserves missing-worktree registrations. It does not request
                immediate object pruning or force a competing collection. Your
                existing Git retention configuration still applies.
              </p>
              <p>
                Storage figures measure loose objects and pack files, not free
                disk space. Temporary repacking needs extra space; snapshots and
                shared blocks can delay space returning to the volume. Garbage
                collection does not remove local branch names.
              </p>
            </details>
          )}
          {action?.kind === "gc" && (
            <p className="maintenance__help">
              {mode === "standard"
                ? "Standard collection"
                : mode === "keep-largest"
                  ? "Keeping the largest pack"
                  : "Aggressive compression"}
              . Git retention settings apply; missing-worktree registrations are
              preserved. Sizes measure object storage, not free disk space.
            </p>
          )}
          {action !== null && tab === "branches" && (
            <p className="maintenance__help">
              Only merged local branches with missing remote upstreams are
              eligible. Deletion rechecks each selected branch; checked-out
              branches and unique commits are retained.
            </p>
          )}
          {error !== null && (
            <div className="modal__error" role="alert">
              {error}
            </div>
          )}
          {scanComplete && candidates.length > 0 && (
            <label className="maintenance__scope">
              <input
                type="checkbox"
                checked={selected.size === candidates.length}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? new Set(candidates.map(branchKey))
                      : new Set()
                  )
                }
              />{" "}
              Select all {candidates.length} eligible{" "}
              {candidates.length === 1 ? "branch" : "branches"}
            </label>
          )}
          {complete && repos.length === 0 && (
            <p className="maintenance__help">
              No known repositories in the selected scope.
            </p>
          )}
          {scanComplete && candidates.length === 0 && (
            <p className="maintenance__help">
              {counts.failed > 0 || summary?.cancelled
                ? "No eligible branches were reported by completed reviews. Resolve failures or cancellation and review again."
                : "No eligible branches found. Fetch first if remote information is stale. Squash-merged branches may need individual review in the repository’s branch list."}
            </p>
          )}
          <div className="maintenance__results" aria-label="Repository results">
            {repos.map((repo) => {
              const result = results.get(repo.id);
              const status =
                result?.outcome ??
                (current === repo.id
                  ? "running"
                  : running
                    ? "queued"
                    : "incomplete");
              return (
                <article
                  className={`bulk-sync__repo is-${status}`}
                  key={repo.id}
                >
                  <div className="bulk-sync__repo-head">
                    <div>
                      <strong>
                        {repo.name}
                        {allProfiles ? ` · ${repo.profileName}` : ""}
                      </strong>
                      <small className="selectable">
                        {displayPath(repo.path, platform)}
                      </small>
                    </div>
                    <span className={`bulk-sync__repo-status is-${status}`}>
                      {status}
                    </span>
                  </div>
                  <p className="selectable">
                    {result?.message ??
                      details.get(repo.id) ??
                      (current === repo.id
                        ? "Git is working…"
                        : running
                          ? "Queued"
                          : "No result received.")}
                  </p>
                  {result?.beforeBytes !== undefined &&
                    result.afterBytes !== undefined && (
                      <p>
                        Object storage: {bytes(result.beforeBytes)} →{" "}
                        {bytes(result.afterBytes)}
                      </p>
                    )}
                  {scanComplete &&
                    result?.candidates?.map((branch) => (
                      <label
                        className="maintenance__branch"
                        key={branch.branch}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(branchKey(branch))}
                          onChange={() => toggleBranch(branchKey(branch))}
                        />
                        <span>
                          <strong>{branch.branch}</strong>
                          <small>
                            Missing upstream:{" "}
                            {branch.upstream.replace(/^refs\/remotes\//, "")} ·
                            tip {branch.expectedHead.slice(0, 8)}
                          </small>
                        </span>
                      </label>
                    ))}
                  {result?.branches !== undefined && (
                    <ul className="bulk-sync__details">
                      {result.branches.map((branch) => (
                        <li key={branch.branch}>
                          <strong>{branch.branch}</strong>: {branch.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              );
            })}
          </div>
        </div>
        <div className="modal__actions">
          {running ? (
            <button
              ref={footerFocus}
              className="modal__cancel"
              aria-disabled={cancelling}
              onClick={() => void cancel()}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          ) : (
            <>
              <button
                ref={footerFocus}
                className="modal__cancel"
                onClick={onClose}
              >
                Close
              </button>
              {action !== null && tab === "gc" && (
                <button className="modal__cancel" onClick={reset}>
                  Change options
                </button>
              )}
              {tab === "gc" ? (
                <button
                  className="modal__create"
                  onClick={() => void run({ kind: "gc", mode })}
                >
                  Run garbage collection
                </button>
              ) : (
                <>
                  <button
                    className="modal__cancel"
                    onClick={() => void run({ kind: "scan-branches" })}
                  >
                    {action === null ? "Review local branches" : "Review again"}
                  </button>
                  {scanComplete && (
                    <button
                      className="modal__create"
                      disabled={selected.size === 0}
                      onClick={() =>
                        void run({
                          kind: "delete-branches",
                          branches: candidates.filter((branch) =>
                            selected.has(branchKey(branch))
                          )
                        })
                      }
                    >
                      Delete {selected.size} selected local{" "}
                      {selected.size === 1 ? "branch" : "branches"}
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
