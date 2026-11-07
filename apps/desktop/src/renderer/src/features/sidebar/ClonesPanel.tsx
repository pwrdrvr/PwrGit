import { useEffect, useRef, useState } from "react";
import {
  EMPTY_MAINTENANCE_RUN_VIEW,
  foldMaintenanceProgress,
  maintenanceViewFromSummary,
  type GitReflinkStatus,
  type MaintenanceRepo,
  type MaintenanceRepoResult,
  type MaintenanceSummary
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { attachMaintenanceRun, markMaintenanceSeen, useMaintenanceRunView } from "./maintenance-attach";
import { displayPath } from "../../lib/platform";
import { formatElapsed } from "../remote/remote-activity";
import { BulkSyncStatus, StatusMark } from "./BulkSyncStatus";
import { countOutcomes } from "./bulk-sync-progress";

/** File data in binary units, for every maintenance receipt. */
export function clonesBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/** What one repository's re-share added up to. Null bytes: Git could not
 *  measure any of it (another filesystem), which is not zero. */
export function repoTotals(result: MaintenanceRepoResult): {
  bytes: number | null;
  files: number;
  left: number;
  worktrees: number;
} {
  const worktrees = result.reshare?.worktrees ?? [];
  const measured = worktrees.filter((worktree) => worktree.sharedBytes !== null);
  return {
    bytes: measured.length === 0 ? null : measured.reduce((sum, worktree) => sum + worktree.sharedBytes!, 0),
    files: worktrees.reduce((sum, worktree) => sum + worktree.reshared, 0),
    left: worktrees.reduce((sum, worktree) => sum + worktree.skipped, 0),
    worktrees: worktrees.length
  };
}

/** The receipt's headline: Git's own count, never "freed". */
export function clonesHeadline(results: MaintenanceRepoResult[]): { title: string; detail: string } {
  let bytes = 0;
  let files = 0;
  let left = 0;
  let worktrees = 0;
  let failed = 0;
  for (const result of results) {
    failed += (result.reshare?.worktrees ?? []).filter((worktree) => worktree.outcome === "failed").length;
    const totals = repoTotals(result);
    bytes += totals.bytes ?? 0;
    files += totals.files;
    left += totals.left;
    worktrees += totals.worktrees;
  }
  const n = (value: number): string => value.toLocaleString("en-US");
  return {
    title:
      files === 0
        ? "Nothing new to share"
        : `${clonesBytes(bytes)} of file data now shared with main checkouts`,
    detail: `${n(worktrees)} ${worktrees === 1 ? "worktree" : "worktrees"} · ${n(files)} ${files === 1 ? "file" : "files"} re-shared · ${n(left)} left as they are${failed > 0 ? ` · ${n(failed)} ${failed === 1 ? "worktree" : "worktrees"} failed` : ""}`
  };
}

const markFor = (outcome: MaintenanceRepoResult["outcome"]): "ok" | "failed" | "cancelled" | "skipped" =>
  outcome === "success" ? "ok" : outcome === "skipped" ? "skipped" : outcome === "cancelled" ? "cancelled" : "failed";

/**
 * Maintenance › Clones: `git worktree reflink` on every linked worktree in
 * scope, after each main checkout is brought up to its default branch.
 * Design: `design/Refresh Clones - UX Review.dc.html`, turn 2.
 */
export function ClonesPanel({
  profileId,
  platform,
  onClose,
  onBusyChange
}: {
  profileId: string;
  platform: string;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [support, setSupport] = useState<GitReflinkStatus | null>(null);
  const [supportError, setSupportError] = useState<string | null>(null);
  const [updateMain, setUpdateMain] = useState(true);
  const [allProfiles, setAllProfiles] = useState(false);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  /** The run as its progress events drew it: the same fold main keeps for
   *  a window that reattaches. */
  const { view, setView, current, details, results } = useMaintenanceRunView();
  /** Reattached to a run another window started: only that window can
   *  cancel it (`maintenance:cancel` checks the owner). */
  const [foreign, setForeign] = useState(false);
  const [summary, setSummary] = useState<MaintenanceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  /** Main has said whether a run is here to reattach to. */
  const [attachChecked, setAttachChecked] = useState(false);
  const operation = useRef<string | null>(null);
  const live = useRef(true);
  const repos = view.repos;
  const noWorktrees = view.noWorktrees ?? [];

  useEffect(() => {
    live.current = true;
    void dispatch("git:reflinkSupport", undefined)
      .then((answer) => {
        if (!live.current) return;
        if (answer.ok) setSupport(answer.value);
        else setSupportError(answer.error.message);
      })
      .catch((cause: unknown) => {
        if (live.current) setSupportError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live.current = false;
      // Closing the dialog mid-run stops the queue; running worktrees finish.
      if (operation.current !== null) void dispatch("maintenance:cancel", { operationId: operation.current });
    };
  }, []);

  useEffect(() => onBusyChange(running), [running, onBusyChange]);

  // A window reload loses this panel but not main's run: pick a live
  // Clones run up again, or show the receipt of one that ended unattended.
  useEffect(
    () =>
      attachMaintenanceRun(profileId, {
        claim: (found) => {
          setAttachChecked(true);
          return found?.run.action.kind === "reshare";
        },
        running: (run, seeded, stopping) => {
          operation.current = run.operationId;
          if (run.action.kind === "reshare") setUpdateMain(run.action.updateMain);
          setAllProfiles(run.allProfiles);
          setRunning(true);
          setCancelling(stopping);
          setForeign(!run.ownWindow);
          setSummary(null);
          setError(null);
          setStartedAt(Date.parse(run.startedAt));
          setView(seeded);
        },
        progress: setView,
        finished: (run, finishedSummary) => {
          operation.current = null;
          if (run.action.kind === "reshare") setUpdateMain(run.action.updateMain);
          setAllProfiles(run.allProfiles);
          setRunning(false);
          setStartedAt(Date.parse(run.startedAt));
          if (finishedSummary === null) {
            setView((old) => ({ ...old, running: [] }));
            setError("Refreshing clones stopped before it finished. See Help › Logs.");
          } else {
            setSummary(finishedSummary);
            setView((old) => maintenanceViewFromSummary(finishedSummary, old));
          }
        }
      }),
    [profileId]
  );

  const start = async (): Promise<void> => {
    if (operation.current !== null) return;
    const operationId = crypto.randomUUID();
    operation.current = operationId;
    setRunning(true);
    setCancelling(false);
    setForeign(false);
    setSummary(null);
    setError(null);
    setView(EMPTY_MAINTENANCE_RUN_VIEW);
    setStartedAt(Date.now());
    const off = subscribe("maintenance:progress", (event) => {
      if (!live.current || event.operationId !== operationId || event.profileId !== profileId) return;
      setView((old) => foldMaintenanceProgress(old, event));
    });
    try {
      const response = await dispatch("maintenance:run", {
        operationId,
        profileId,
        allProfiles,
        action: { kind: "reshare", updateMain }
      });
      if (!live.current) return;
      if (response.ok) {
        const finished = response.value;
        setSummary(finished);
        setView((old) => maintenanceViewFromSummary(finished, old));
      } else {
        setError(response.error.message);
      }
    } catch (cause) {
      if (live.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      off();
      operation.current = null;
      // This window heard the answer, so the receipt is not shown again on
      // the next open — also when the dialog closed (and cancelled) first.
      markMaintenanceSeen(profileId, operationId);
      if (live.current) {
        setRunning(false);
        setView((old) => (old.running.length === 0 ? old : { ...old, running: [] }));
      }
    }
  };

  const cancel = (): void => {
    if (operation.current === null) return;
    setCancelling(true);
    void dispatch("maintenance:cancel", { operationId: operation.current });
  };

  const openSettings = (): void => {
    void dispatch("settings:open", { page: "git", sub: "runtime" }).then((result) => {
      if (!result.ok) setError(result.error.message);
    });
  };

  const counts = countOutcomes([...results.values()].map((result) => result.outcome));
  const unavailable = support !== null && !support.support.reshare;
  const started = running || summary !== null;
  const ordered = summary === null
    ? repos
    : [...repos].sort((a, b) => (repoTotals(results.get(b.id)!).bytes ?? 0) - (repoTotals(results.get(a.id)!).bytes ?? 0));
  const headline = summary === null ? null : clonesHeadline(summary.results);
  // Separate clones of one project share a name; their path tells them apart.
  const repeatedNames = repeatedRepoNames(ordered);
  const version = support?.version?.replace(/^git version /, "") ?? null;

  return (
    <>
      {summary !== null && headline !== null ? (
        <div className={`maintenance__done-status${counts.failed + counts.partial > 0 || summary.cancelled ? " is-stopped" : ""}`}>
          <StatusMark mark={summary.cancelled ? "cancelled" : counts.failed + counts.partial > 0 ? "failed" : "ok"} />
          <div>
            <strong>{summary.cancelled ? `Stopped · ${headline.title}` : headline.title}</strong>
            <small>{headline.detail}</small>
          </div>
          <time>took {formatElapsed(Date.parse(summary.finishedAt) - Date.parse(summary.startedAt))}</time>
        </div>
      ) : null}
      <div className="maintenance__body">
        {running && (
          <BulkSyncStatus
            phase={cancelling ? "cancelling" : "running"}
            hasFailures={counts.failed + counts.partial > 0}
            title={
              cancelling
                ? "Stopping after the worktrees already running…"
                : current.size > 0
                  ? `Refreshing clones in ${current.size} ${current.size === 1 ? "repository" : "repositories"}`
                  : "Waiting for the next repository…"
            }
            detail={
              current.size > 0
                ? { kind: "path", text: repos.filter((repo) => current.has(repo.id)).map((repo) => repo.name).join(" · ") }
                : null
            }
            counts={counts}
            inFlight={current.size}
            queued={Math.max(0, repos.length - results.size - current.size)}
            startedAt={startedAt}
            durationMs={null}
            estimateRemaining={false}
          />
        )}
        {!started && (
          <>
            {supportError !== null && <div className="modal__error">{supportError}</div>}
            {unavailable ? (
              <div className="maintenance__clones-block" role="note">
                <strong>Refreshing clones needs PwrGit’s Git</strong>
                <p>
                  The Git in use{version === null ? "" : ` (${version})`} has no <code>git worktree reflink</code>.
                  {support.support.checkout
                    ? " It clones files on checkout, but re-sharing a worktree needs PwrGit’s Git 2.56.0-dev-pwrgit.2 or newer."
                    : " Choose PwrGit’s Git in Settings › Git."}
                </p>
                <button className="maintenance__clones-link" type="button" onClick={openSettings}>
                  Open Git settings
                </button>
              </div>
            ) : (
              <p className="maintenance__clones-lead">
                Turn files every worktree holds <strong>unchanged</strong> back into copy-on-write clones of
                its main checkout, so they share disk space again. Edited, untracked and ignored files stay
                exactly as they are: Git compares the bytes before it shares anything.
              </p>
            )}
            <div className="maintenance__options">
              <label>
                <input
                  type="checkbox"
                  checked={updateMain}
                  disabled={unavailable}
                  onChange={(event) => setUpdateMain(event.target.checked)}
                />
                <span>
                  Update main checkouts first
                  <small>
                    Fetch, then fast-forward a main checkout that is clean and on its default branch, as Try
                    pull does. Any other main checkout is left as it is.
                  </small>
                </span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={allProfiles}
                  disabled={unavailable}
                  onChange={(event) => setAllProfiles(event.target.checked)}
                />
                <span>
                  Include all profiles
                  <small>
                    {allProfiles
                      ? "Every known repository across all profiles."
                      : "Every known repository in this window’s profile."}
                  </small>
                </span>
              </label>
            </div>
            <p className="maintenance__help">
              Runs on every linked worktree, with no age or Focused filter. Missing and locked worktrees are
              listed and left alone. Cancel stops after the worktrees already running.
            </p>
          </>
        )}
        {error !== null && started && <div className="modal__error">{error}</div>}
        {started && ordered.length > 0 && (
          <ul className="maintenance__clones-rows" aria-label="Repositories">
            {ordered.map((repo) => (
              <CloneRepoRow
                key={repo.id}
                repo={repo}
                running={current.has(repo.id)}
                detail={details.get(repo.id)}
                result={results.get(repo.id)}
                platform={platform}
                showPath={repeatedNames.has(repo.name)}
              />
            ))}
          </ul>
        )}
        {started && noWorktrees.length > 0 && (
          <details className="maintenance__clones-none">
            <summary>
              {noWorktrees.length.toLocaleString("en-US")} {noWorktrees.length === 1 ? "repository has" : "repositories have"} no
              linked worktrees, so nothing to share
            </summary>
            <p>{noWorktrees.map((repo) => repo.name).join(" · ")}</p>
          </details>
        )}
        {summary !== null && (
          <p className="maintenance__help">
            Git counts file data that stopped being private. Free space can differ: deleting a clone frees
            nothing, and a local Time Machine snapshot keeps old blocks until it expires.
          </p>
        )}
      </div>
      <div className="modal__actions">
        {running ? (
          <>
            {foreign && !cancelling && (
              <span className="maintenance__footer-lead">Started in another window, which alone can cancel it.</span>
            )}
            <button className="modal__cancel" disabled={cancelling || foreign} onClick={cancel}>
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          </>
        ) : (
          <>
            {summary === null && <button className="modal__cancel" onClick={onClose}>Close</button>}
            <button
              className={summary === null ? "modal__create" : "modal__cancel"}
              disabled={support === null || unavailable || !attachChecked}
              onClick={() => void start()}
            >
              {summary === null ? "Refresh clones" : "Run again"}
            </button>
            {/* Once the run is over, Close is the primary: last, in the CTA colour. */}
            {summary !== null && <button className="modal__create" onClick={onClose}>Close</button>}
          </>
        )}
      </div>
    </>
  );
}

/** Names held by more than one repository in the list. */
export function repeatedRepoNames(repos: readonly MaintenanceRepo[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const repo of repos) (seen.has(repo.name) ? repeated : seen).add(repo.name);
  return repeated;
}

function CloneRepoRow({
  repo,
  running,
  detail,
  result,
  platform,
  showPath
}: {
  repo: MaintenanceRepo;
  running: boolean;
  detail: string | undefined;
  result: MaintenanceRepoResult | undefined;
  platform: string;
  showPath: boolean;
}) {
  const totals = result === undefined ? null : repoTotals(result);
  const mark = result === undefined ? null : markFor(result.outcome);
  const head = (
    <>
      {running ? (
        <span className="bulk-sync__spinner" aria-hidden="true" />
      ) : mark === null ? (
        <span className="maintenance__clones-queued" aria-hidden="true" />
      ) : mark === "skipped" ? (
        <span className="maintenance__clones-queued is-skipped" aria-hidden="true" />
      ) : (
        <StatusMark mark={mark} />
      )}
      <span className="maintenance__clones-name">
        <strong>{repo.name}</strong>
        {showPath ? <code className="selectable">{displayPath(repo.path, platform)}</code> : null}
        <small>{result?.message ?? (running ? detail ?? "Starting…" : "Queued")}</small>
      </span>
      <span className="maintenance__clones-bytes">
        {totals === null || totals.worktrees === 0 ? "" : totals.bytes === null ? "—" : clonesBytes(totals.bytes)}
      </span>
    </>
  );
  const worktrees = result?.reshare?.worktrees ?? [];
  if (worktrees.length === 0) return <li className="maintenance__clones-row">{head}</li>;
  return (
    <li className="maintenance__clones-row">
      <details>
        <summary>{head}</summary>
        <ul className="maintenance__clones-worktrees">
          {worktrees.map((worktree) => (
            <li key={worktree.worktreeId}>
              <span>
                <strong>{worktree.branch || "(detached)"}</strong>
                <code className="selectable">{displayPath(worktree.path, platform)}</code>
                <small className={worktree.outcome === "failed" ? "is-failed" : undefined}>{worktree.message}</small>
              </span>
              <span className="maintenance__clones-bytes">
                {worktree.sharedBytes === null ? "—" : clonesBytes(worktree.sharedBytes)}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}
