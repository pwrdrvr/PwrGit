// Settings › Git › PwrGit’s Git: newer builds of PwrGit's own Git, published
// between app releases. Download and Use are separate, explicit actions:
// installing never changes which Git runs, and a Git chosen by path stays
// chosen. Design: `design/Git Settings and Managed Updates - UX Review.dc.html`.

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  MANAGED_GIT_INSTALL_PHASES,
  type GitRuntimeStatus,
  type ManagedGitBuild,
  type ManagedGitInstallPhase,
  type ManagedGitStatus
} from "@pwrgit/shared";
import { CheckGlyph } from "../../lib/CheckGlyph";
import { CloseGlyph } from "../../lib/CloseGlyph";
import { copyText } from "../../lib/copyText";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { useRelativeClock } from "../../lib/useRelativeClock";
import type { GitSettingsState } from "./GitSettingsContext";
import {
  INSTALL_PHASE_LABEL,
  SOURCE_LABEL,
  TRUST_LABEL,
  checkedAgo,
  describeVersion,
  downloadedBuild,
  inUseCandidate,
  isInstallPhase,
  managedCardState,
  managedInUse,
  megabytes,
  phaseSentence,
  type ManagedCardState
} from "./git-settings-view";
import { MetaParts } from "./GitMetaParts";
import { SettingsField, SettingsSection, settingsChipClass } from "./SettingsLayout";

const DESCRIPTION =
  "Newer builds of PwrGit’s Git are published between app releases. PwrGit checks each one’s checksum and signature before it can be used, and keeps the one you were on.";

function publishedLine(managed: ManagedGitStatus): string[] {
  const latest = managed.latest;
  if (latest === null) return [];
  const parts: string[] = [];
  if (latest.publishedAt !== null) {
    const date = new Date(latest.publishedAt);
    if (!Number.isNaN(date.getTime())) {
      parts.push(`published ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
    }
  }
  if (latest.size !== null) parts.push(megabytes(latest.size));
  return parts;
}

/** The version PwrGit runs right now, for "keep using X meanwhile". */
function runningVersion(managed: ManagedGitStatus, runtime: GitRuntimeStatus | null): string {
  const current = runtime === null ? undefined : inUseCandidate(runtime);
  if (current?.git != null) return describeVersion("git", current.git).version;
  return managedInUse(managed)?.version ?? managed.bundledVersion;
}

/** Download → Checksum → Unpack → Files and signatures → Test run, each marked
 *  done, running, failed or waiting. The mark is drawn and also spoken. */
function InstallSteps(props: { at: ManagedGitInstallPhase | null; failed: boolean }) {
  const index = props.at === null ? -1 : MANAGED_GIT_INSTALL_PHASES.indexOf(props.at);
  return (
    <ol className="settings-git-steps" aria-label="Install steps">
      {MANAGED_GIT_INSTALL_PHASES.map((phase, position) => {
        const state =
          position < index ? "done" : position === index ? (props.failed ? "failed" : "active") : "waiting";
        // Drawn, not typed: ✓ and ✕ are in neither bundled face (styles/AGENTS.md).
        const mark =
          state === "done" ? <CheckGlyph size={10} /> : state === "failed" ? <CloseGlyph size={10} /> : <span className="settings-git-step__dot" />;
        const spoken = state === "done" ? "done" : state === "failed" ? "failed" : state === "active" ? "running" : "waiting";
        return (
          <li key={phase} className={`settings-git-step is-${state}`}>
            <span aria-hidden="true" className="settings-git-step__mark">
              {mark}
            </span>
            {INSTALL_PHASE_LABEL[phase]}
            <span className="a11y-sr-only">, {spoken}</span>
          </li>
        );
      })}
    </ol>
  );
}

function InstallProgress(props: {
  managed: ManagedGitStatus;
  state: ManagedCardState;
  cancelRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
}) {
  const progress = props.managed.progress;
  const phase = progress !== null && isInstallPhase(progress.phase) ? progress.phase : null;
  const downloading = phase === "downloading" || progress?.phase === "checking";
  const received = progress?.receivedBytes ?? 0;
  const total = progress?.totalBytes ?? 0;
  const amount = total > 0 ? `${megabytes(received).replace(" MB", "")} of ${megabytes(total)}` : megabytes(received);
  const rate = progress?.bytesPerSecond;
  const percent = downloading ? (props.state.percent ?? 0) : 100;
  return (
    <div className="settings-git-progress">
      <div className="settings-git-progress__row">
        <div
          aria-label={`Installing ${progress?.version ?? "PwrGit’s Git"}`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          aria-valuetext={downloading ? amount : props.state.chip?.label}
          className="settings-git-progress__bar"
          role="progressbar"
        >
          <span className="settings-git-progress__fill" style={{ width: `${percent}%` }} />
        </div>
        <button ref={props.cancelRef} className="settings-button" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      {downloading ? (
        <span className="settings-field__detail">
          {rate !== undefined && rate > 0 ? `${amount} · ${megabytes(rate)}/s` : amount}
        </span>
      ) : null}
      <InstallSteps at={phase ?? "downloading"} failed={false} />
    </div>
  );
}

function BuildRows(props: {
  managed: ManagedGitStatus;
  runtime: GitRuntimeStatus | null;
  busy: boolean;
  onUse: (build: ManagedGitBuild) => void;
}) {
  const { managed } = props;
  const running = managedInUse(managed);
  return (
    <ul className="settings-ai-installs" aria-label="Downloaded builds">
      {managed.builds.map((build) => {
        const using = running?.id === build.id;
        const candidate = props.runtime?.candidates.find((row) => row.managedId === build.id);
        const parts = [
          TRUST_LABEL[build.trust],
          build.lfsVersion === null ? null : `LFS ${build.lfsVersion}`,
          candidate?.reflink?.checkout === true ? "Copy-on-write" : null,
          build.id === managed.previous ? "Previous, kept for rollback" : null
        ].filter((part) => part !== null);
        return (
          <li key={build.id} className={`settings-ai-install${using ? " is-using" : ""}`}>
            <span className="settings-ai-install__body">
              <span className="settings-ai-install__path">{build.version}</span>
              <MetaParts parts={parts} />
            </span>
            {using ? (
              <span className={settingsChipClass("ok")}>Using</span>
            ) : (
              <button
                aria-disabled={props.busy}
                aria-label={`Use ${build.version}`}
                className="settings-inline-button"
                type="button"
                onClick={() => {
                  if (!props.busy) props.onUse(build);
                }}
              >
                Use
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ManagedGitSection(props: { git: GitSettingsState; onOpenUpdates?: (() => void) | undefined }) {
  const { git } = props;
  const managed = git.managed;
  const state = managed === null ? null : managedCardState(managed);
  const now = useRelativeClock();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Focus follows the action the reader took, never a background change:
  // Download → Cancel → Use (or Try again). A window that only watches an
  // install started elsewhere keeps its focus where it is.
  const following = useRef(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const useBuildRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const kind = state?.kind;
  useEffect(() => {
    if (!following.current) return;
    if (kind === "installing") cancelRef.current?.focus();
    else if (kind === "ready") {
      useBuildRef.current?.focus();
      following.current = false;
    } else if (kind === "failed") {
      retryRef.current?.focus();
      following.current = false;
    } else if (kind !== undefined) following.current = false;
  }, [kind]);

  const install = (version: string): void => {
    setError(null);
    following.current = true;
    void git.install(version).then((failure) => {
      // A failure main reported as progress is shown by the steps; this is
      // for one it refused before starting ("still installing").
      if (failure !== null && git.managed?.progress?.phase !== "failed") setError(failure);
    });
  };
  const use = (build: ManagedGitBuild | null): void => {
    setError(null);
    void git.select(build === null ? { path: null } : { managed: build.id }).then(setError);
  };

  const chip = state?.chip;
  return (
    <SettingsSection
      eyebrow="Git"
      title="PwrGit’s Git"
      sectionId="managed"
      description={DESCRIPTION}
      chip={chip?.label}
      chipKind={chip?.tone ?? "default"}
    >
      {/* Phase changes only; byte counts would drown a screen reader. */}
      <p aria-live="polite" className="a11y-sr-only">
        {phaseSentence(managed)}
      </p>
      {managed === null ? (
        <p className="settings-empty" role={git.managedError === null ? "status" : "alert"}>
          {git.managedError ?? "Reading downloaded builds…"}
        </p>
      ) : !managed.supported ? (
        <p className="settings-empty">
          PwrGit offers its own Git builds for macOS, and for Linux on x64 and arm64. Here it runs the bundled Git, or
          one you choose under Installs.
        </p>
      ) : (
        <ManagedFields
          git={git}
          managed={managed}
          state={state as ManagedCardState}
          now={now}
          error={error}
          copied={copied}
          refs={{ cancelRef, useBuildRef, retryRef }}
          onInstall={install}
          onUse={use}
          onCopy={(text) => {
            void copyText(text).then(() => setCopied(true));
          }}
          onOpenUpdates={props.onOpenUpdates}
        />
      )}
    </SettingsSection>
  );
}

function ManagedFields(props: {
  git: GitSettingsState;
  managed: ManagedGitStatus;
  state: ManagedCardState;
  now: number;
  error: string | null;
  copied: boolean;
  refs: {
    cancelRef: RefObject<HTMLButtonElement | null>;
    useBuildRef: RefObject<HTMLButtonElement | null>;
    retryRef: RefObject<HTMLButtonElement | null>;
  };
  onInstall: (version: string) => void;
  /** A build, or null for the bundled one. */
  onUse: (build: ManagedGitBuild | null) => void;
  onCopy: (text: string) => void;
  onOpenUpdates?: (() => void) | undefined;
}) {
  const { git, managed, state } = props;
  const runtime = git.runtime;
  const latest = managed.latest;
  const running = managedInUse(managed);
  const busy = git.selecting || state.kind === "installing";
  const installedChosen = runtime?.active === "installed" ? inUseCandidate(runtime) : undefined;
  const latestBuild = latest === null ? undefined : downloadedBuild(managed, latest.version);
  const progress = managed.progress;
  const failedPhase =
    progress?.phase === "failed" && progress.failedPhase !== undefined && progress.failedPhase !== "checking"
      ? progress.failedPhase
      : null;
  const retryVersion = progress?.version ?? latest?.version;

  const checkNow = (
    <button
      aria-busy={git.checking}
      aria-disabled={git.checking || state.kind === "installing"}
      className="settings-button"
      type="button"
      onClick={() => {
        if (!git.checking && state.kind !== "installing") void git.check(true);
      }}
    >
      <RefreshGlyph />
      {git.checking ? "Checking…" : "Check now"}
    </button>
  );

  return (
    <div className="settings-fields">
      {installedChosen !== undefined ? (
        <SettingsField
          label="In use instead"
          sub={`${SOURCE_LABEL[installedChosen.source]} · not verified by PwrGit`}
          control={
            <>
              <span className="settings-field__value">
                {installedChosen.git === null ? "Didn’t run" : describeVersion("git", installedChosen.git).version}
              </span>
              <span className="settings-field__detail">{installedChosen.path}</span>
            </>
          }
          help="You chose this Git by path, so PwrGit keeps running it. Use below switches to a verified build."
        />
      ) : null}
      <SettingsField
        label="Bundled with PwrGit"
        control={
          <span className="settings-git-version">
            <span className="settings-field__value">{managed.bundledVersion}</span>
            {runtime?.active === "bundled" ? <span className={settingsChipClass("ok")}>In use</span> : null}
          </span>
        }
      />
      <SettingsField
        label="Latest"
        sub={checkedAgo(managed.checkedAt, props.now)}
        control={
          <>
            <span className="settings-git-version">
              {latest === null ? (
                <span className="settings-field__value settings-field__value--absent">
                  {managed.checkedAt === null ? "Not checked yet" : `Nothing newer than ${managed.bundledVersion}`}
                </span>
              ) : (
                <span className="settings-field__value">{latest.version}</span>
              )}
              {latestBuild !== undefined && running?.id === latestBuild.id ? (
                <span className={settingsChipClass("ok")}>In use</span>
              ) : latestBuild !== undefined ? (
                <span className={settingsChipClass("default")}>Downloaded</span>
              ) : null}
            </span>
            {state.kind !== "installing" && publishedLine(managed).length > 0 ? (
              <MetaParts parts={publishedLine(managed)} />
            ) : null}
            {state.kind === "installing" ? (
              <InstallProgress managed={managed} state={state} cancelRef={props.refs.cancelRef} onCancel={git.cancel} />
            ) : null}
            {state.kind === "failed" ? (
              <>
                <InstallSteps at={failedPhase} failed={failedPhase !== null} />
                <p className="settings-field__error" role="alert">
                  {progress?.error ?? "The install failed."} You’re still on {runningVersion(managed, runtime)}.
                </p>
                <div className="settings-field__actions">
                  {retryVersion !== undefined ? (
                    <button
                      ref={props.refs.retryRef}
                      className="settings-button settings-button--primary"
                      type="button"
                      onClick={() => props.onInstall(retryVersion)}
                    >
                      Try again
                    </button>
                  ) : null}
                  <button
                    className="settings-button"
                    type="button"
                    onClick={() => props.onCopy(`${retryVersion ?? ""}: ${progress?.error ?? ""}`.trim())}
                  >
                    {props.copied ? "Copied" : "Copy details"}
                  </button>
                </div>
              </>
            ) : (
              <div className="settings-field__actions">
                {state.kind === "update" && latest !== null ? (
                  <button
                    className="settings-button settings-button--primary"
                    type="button"
                    onClick={() => props.onInstall(latest.version)}
                  >
                    Download and verify
                  </button>
                ) : null}
                {state.kind === "ready" && latestBuild !== undefined ? (
                  <button
                    ref={props.refs.useBuildRef}
                    aria-disabled={busy}
                    aria-label={`Use ${latestBuild.version}`}
                    className="settings-button settings-button--primary"
                    type="button"
                    onClick={() => {
                      if (!busy) props.onUse(latestBuild);
                    }}
                  >
                    Use {latestBuild.version}
                  </button>
                ) : null}
                {state.kind !== "installing" ? checkNow : null}
              </div>
            )}
            {state.kind === "update" ? (
              <span className="settings-field__help">Downloading doesn’t switch Git. You choose when to use it.</span>
            ) : state.kind === "installing" ? (
              <span className="settings-field__help">
                Repositories keep using {runningVersion(managed, runtime)} meanwhile.
              </span>
            ) : state.kind === "ready" ? (
              <span className="settings-field__help">
                Operations already running finish on the Git they started with. Nothing is restarted.
              </span>
            ) : null}
            {managed.checkError !== null ? (
              <span className="settings-field__help">
                Couldn’t check for newer builds: {managed.checkError}. Downloaded builds are checked on disk before
                each use and work offline.
              </span>
            ) : null}
            {managed.needsAppUpdate !== null ? (
              <span className="settings-field__help">
                {managed.needsAppUpdate} is published but needs a newer PwrGit to verify it.
                {props.onOpenUpdates !== undefined ? (
                  <button className="settings-inline-button" type="button" onClick={props.onOpenUpdates}>
                    Settings › Updates
                  </button>
                ) : null}
              </span>
            ) : null}
          </>
        }
        error={managed.selectedError ?? props.error ?? undefined}
      />
      <SettingsField
        label="Downloaded"
        sub={`Verified builds on this ${window.pwrgit.platform === "darwin" ? "Mac" : "machine"}`}
        control={
          managed.builds.length === 0 ? (
            <span className="settings-field__value settings-field__value--absent">None yet</span>
          ) : (
            <>
              <BuildRows
                managed={managed}
                runtime={runtime}
                busy={busy}
                onUse={props.onUse}
              />
              {running !== undefined ? (
                <div className="settings-field__actions">
                  <button
                    aria-disabled={busy}
                    className="settings-button"
                    type="button"
                    onClick={() => {
                      if (!busy) props.onUse(null);
                    }}
                  >
                    Use bundled {managed.bundledVersion}
                  </button>
                </div>
              ) : null}
            </>
          )
        }
      />
    </div>
  );
}
