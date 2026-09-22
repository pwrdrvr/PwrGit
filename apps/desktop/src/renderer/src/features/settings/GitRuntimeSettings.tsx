import { useEffect, useState } from "react";
import type {
  GitRuntimeCandidate,
  GitRuntimeProblem,
  GitRuntimeSource,
  GitRuntimeStatus
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { ReadError } from "../shell/ReadError";
import { ManualPathInput } from "./ManualPathInput";
import {
  SettingsField,
  SettingsSection,
  settingsChipClass,
  type SettingsChipTone
} from "./SettingsLayout";

type Tool = "git" | "lfs";

/** What each row calls where its Git came from. */
const SOURCE_LABEL: Record<GitRuntimeSource, string> = {
  bundled: "Bundled",
  path: "PATH",
  homebrew: "Homebrew",
  user: "User",
  xcode: "Apple",
  custom: "Custom"
};

/** The chip a Git that cannot be chosen carries instead of Use. */
const PROBLEM_LABEL: Record<GitRuntimeProblem, string> = {
  not_found: "Not found",
  no_version: "Didn’t run",
  lfs_missing: "LFS missing"
};

/**
 * `git --version` and `git lfs version` print sentences, not versions:
 * `git version 2.53.0`, and `git-lfs/3.7.1 (GitHub; darwin arm64; go 1.24.0)`.
 * The row's label already names the tool, so the value is the version alone.
 * The full output is kept beneath it only when it says more than that — LFS's
 * build tail does, `git version 2.53.0` does not. Output in a shape neither
 * pattern knows is shown whole rather than guessed at.
 */
export function describeVersion(
  tool: Tool,
  output: string
): { version: string; detail?: string } {
  const text = output.trim();
  const match = (tool === "git" ? /^git version (\S+)/ : /^git-lfs\/(\S+)/).exec(text);
  const version = match?.[1];
  if (version === undefined) return { version: text };
  const canonical = tool === "git" ? `git version ${version}` : `git-lfs/${version}`;
  return text === canonical ? { version } : { version, detail: text };
}

/** The row PwrGit runs. `path` always names one; a missing row is the same
 *  outage as a Git that did not answer. */
function inUse(status: GitRuntimeStatus): GitRuntimeCandidate | undefined {
  return status.candidates.find((candidate) => candidate.path === status.path);
}

/**
 * The chip reports the one fact the card is for, and has to be able to be
 * wrong: a Git that cannot run is the state where no repository operation can,
 * so it is the state the header must not describe as fine. A probe that never
 * answered is a third answer — "we could not look" is not "it is missing". No
 * chip at all while the first probe is in flight.
 */
function runtimeChip(
  status: GitRuntimeStatus | null,
  failed: boolean
): { label?: string; tone: SettingsChipTone } {
  if (failed) return { label: "Unknown", tone: "warn" };
  if (status === null) return { tone: "default" };
  if (inUse(status)?.git == null) return { label: "Unavailable", tone: "err" };
  return { label: status.active === "bundled" ? "Bundled" : "Installed", tone: "default" };
}

/** One row's reading: the version in mono, then any machine detail (the tool's
 *  full output, the executable path) in the smaller mono About uses for URLs.
 *  A missing tool reads as absence, not as a value. */
function Reading(props: {
  tool: Tool;
  output: string | null;
  missing: string;
  path?: string;
}) {
  const reading =
    props.output === null ? null : describeVersion(props.tool, props.output);
  return (
    <>
      {reading === null ? (
        <span className="settings-field__value settings-field__value--absent">
          {props.missing}
        </span>
      ) : (
        <span className="settings-field__value">{reading.version}</span>
      )}
      {reading?.detail !== undefined ? (
        <span className="settings-field__detail">{reading.detail}</span>
      ) : null}
      {props.path !== undefined ? (
        <span className="settings-field__detail">{props.path}</span>
      ) : null}
    </>
  );
}

/** `2.53.0 · LFS 3.7.1` — the versions a row is chosen by. */
function rowMeta(candidate: GitRuntimeCandidate): string {
  return [
    SOURCE_LABEL[candidate.source],
    candidate.git === null ? null : describeVersion("git", candidate.git).version,
    candidate.lfs === null ? null : `LFS ${describeVersion("lfs", candidate.lfs).version}`
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

function GitInstalls(props: {
  status: GitRuntimeStatus;
  busy: boolean;
  onSelect: (path: string | null) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  // The path ellipsises, so the full string has to stay readable — through a
  // card, never a native `title` (lib/AGENTS.md).
  const tip = useViewportTooltip();
  return (
    <>
      <ul className="settings-ai-installs" aria-label="Git installs">
        {props.status.candidates.map((candidate) => {
          const using = candidate.path === props.status.path;
          return (
            <li key={candidate.path} className={`settings-ai-install${using ? " is-using" : ""}`}>
              <span className="settings-ai-install__body">
                <span className="settings-ai-install__path" {...hoverTooltip(tip, candidate.path)}>
                  {candidate.path}
                </span>
                <span className="settings-ai-install__meta">{rowMeta(candidate)}</span>
              </span>
              {using ? (
                <span className={settingsChipClass(candidate.problem === null ? "ok" : "err")}>
                  {candidate.problem === null ? "Using" : PROBLEM_LABEL[candidate.problem]}
                </span>
              ) : candidate.problem !== null ? (
                // A Git that cannot run Git LFS is still listed, so its absence
                // is explained rather than mysterious — it just cannot be chosen.
                <span className={settingsChipClass("err")}>{PROBLEM_LABEL[candidate.problem]}</span>
              ) : (
                <button
                  aria-disabled={props.busy}
                  aria-label={`Use ${candidate.path}`}
                  className="settings-inline-button"
                  type="button"
                  onClick={() => {
                    if (props.busy) return;
                    setError(null);
                    void props
                      .onSelect(candidate.source === "bundled" ? null : candidate.path)
                      .then(setError);
                  }}
                >
                  Use
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error !== null && (
        <p className="settings-field__error" role="alert">
          {error}
        </p>
      )}
      {tip.tooltipNode}
    </>
  );
}

export function GitRuntimeDetails(props: {
  status: GitRuntimeStatus;
  busy: boolean;
  checking: boolean;
  onSelect: (path: string | null) => Promise<string | null>;
  onRecheck: () => void;
}) {
  const { status } = props;
  const current = inUse(status);
  const bundled = status.active === "bundled";
  const gitMissing = current?.git == null;
  const platform = window.pwrgit.platform;
  return (
    <div className="settings-fields">
      <SettingsField
        label="Git"
        control={
          <Reading
            tool="git"
            output={current?.git ?? null}
            missing="Didn’t run"
            path={status.path}
          />
        }
        error={
          !gitMissing
            ? undefined
            : bundled
              ? "PwrGit can’t run its bundled Git, so repository operations will fail. Reinstalling PwrGit restores it."
              : "PwrGit can’t run the Git chosen below, so repository operations will fail. Choose another Git, or the bundled one."
        }
      />
      <SettingsField
        label="Git LFS"
        control={<Reading tool="lfs" output={current?.lfs ?? null} missing="Not found" />}
        // With Git itself missing, the row above already says nothing will run.
        error={
          gitMissing || current?.lfs != null
            ? undefined
            : bundled
              ? "Repositories that use Git LFS will fail to check out or push their LFS files. Reinstalling PwrGit restores it."
              : "Repositories that use Git LFS will check out pointer files. Install Git LFS for this Git, or choose another."
        }
      />
      {/* Only the bundle borrows a helper: an installed Git reads its own
          system config, keychain helper included. */}
      {platform === "darwin" && bundled ? (
        <SettingsField
          label="HTTPS sign-in"
          control={
            status.keychainHelper === null ? (
              <span className="settings-field__value settings-field__value--absent">
                No keychain helper
              </span>
            ) : (
              <>
                <span className="settings-field__value">macOS keychain</span>
                <span className="settings-field__detail">{status.keychainHelper}</span>
              </>
            )
          }
          help={
            status.keychainHelper === null
              ? "Bundled Git signs in to HTTPS remotes through the keychain helper of an installed Git, and none was found. Install Git from Homebrew or the Xcode Command Line Tools, or use an SSH remote."
              : "Borrowed from your installed Git, so the passwords it saved keep working."
          }
        />
      ) : null}
      <SettingsField
        label="Installs"
        sub="Bundled with PwrGit or found on this machine. A Git needs Git LFS to be chosen."
        control={
          <>
            <GitInstalls status={status} busy={props.busy} onSelect={props.onSelect} />
            <div className="settings-field__actions">
              <button
                aria-busy={props.checking}
                aria-disabled={props.checking}
                className="settings-button"
                type="button"
                onClick={() => {
                  if (!props.checking) props.onRecheck();
                }}
              >
                <RefreshGlyph />
                {props.checking ? "Checking…" : "Re-check"}
              </button>
            </div>
          </>
        }
      />
      <SettingsField
        label="Custom path"
        sub="A Git the list does not find."
        control={
          <ManualPathInput
            executable="git"
            label="Custom Git path"
            saved={bundled ? "" : status.path}
            saveLabel="Use path"
            disabled={props.busy}
            onSave={props.onSelect}
            onClear={() => props.onSelect(null)}
          />
        }
      />
    </div>
  );
}

export function GitRuntimeSettings() {
  const [status, setStatus] = useState<GitRuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  // The probe is a handful of 5 s execs that can lose to a cold disk. Without
  // a way to ask again, one lost race left the card wrong until the Settings
  // window was reopened — so a failed read offers Try again, as About does.
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let disposed = false;
    setError(null);
    setChecking(true);
    void dispatch("git:runtimeStatus", undefined)
      .then((result) => {
        if (disposed) return;
        if (result.ok) setStatus(result.value);
        else setError(result.error.message);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!disposed) setChecking(false);
      });
    return () => {
      disposed = true;
    };
  }, [request]);

  /** Resolves to the failure, or null — the shape the path field and the rows
   *  put beside themselves. */
  const select = async (path: string | null): Promise<string | null> => {
    setBusy(true);
    try {
      const result = await dispatch("git:selectRuntime", { path });
      if (!result.ok) return result.error.message;
      setStatus(result.value);
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    } finally {
      setBusy(false);
    }
  };

  const chip = runtimeChip(status, error !== null);
  return (
    <SettingsSection
      eyebrow="Git"
      title="Git runtime"
      sectionId="git-runtime"
      description="PwrGit runs its own bundled Git and Git LFS, so repository operations don’t depend on what’s installed on this machine. Pick an installed Git below to use it instead."
      chip={chip.label}
      chipKind={chip.tone}
    >
      {error !== null ? (
        <ReadError
          title="Git versions couldn’t be read"
          message={error}
          onRetry={() => setRequest((current) => current + 1)}
        />
      ) : status === null ? (
        <p className="settings-empty" role="status">
          Checking Git versions…
        </p>
      ) : (
        <GitRuntimeDetails
          status={status}
          busy={busy}
          checking={checking}
          onSelect={select}
          onRecheck={() => setRequest((current) => current + 1)}
        />
      )}
    </SettingsSection>
  );
}
