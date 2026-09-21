import { useEffect, useState } from "react";
import type { Res } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { ReadError } from "../shell/ReadError";
import {
  SettingsField,
  SettingsSection,
  type SettingsChipTone
} from "./SettingsLayout";

type Status = Res<"git:runtimeStatus">;
type Tool = "git" | "lfs";

/** The chip's word for each runtime `git:runtimeStatus` can report as active.
 *  Bundled is the only one today; a second runtime has to be named here, so the
 *  chip reads the payload rather than restating a constant. */
const RUNTIME_LABEL: Record<Status["active"], string> = { bundled: "Bundled" };

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

/**
 * The chip reports the one fact the card is for, and has to be able to be
 * wrong: a missing bundled Git is the state where no repository operation can
 * run, so it is the state the header must not describe as fine. A probe that
 * never answered is a third answer — "we could not look" is not "it is
 * missing". No chip at all while the first probe is in flight.
 */
function runtimeChip(
  status: Status | null,
  failed: boolean
): { label?: string; tone: SettingsChipTone } {
  if (failed) return { label: "Unknown", tone: "warn" };
  if (status === null) return { tone: "default" };
  if (status.bundled.git === null) return { label: "Unavailable", tone: "err" };
  return { label: RUNTIME_LABEL[status.active], tone: "default" };
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

export function GitRuntimeDetails({ status }: { status: Status }) {
  const gitMissing = status.bundled.git === null;
  return (
    <div className="settings-fields">
      <SettingsField
        label="Bundled Git"
        control={
          <Reading
            tool="git"
            output={status.bundled.git}
            missing="Not found"
            path={status.path}
          />
        }
        error={
          gitMissing
            ? "PwrGit can’t run its bundled Git, so repository operations will fail. Reinstalling PwrGit restores it."
            : undefined
        }
      />
      <SettingsField
        label="Bundled Git LFS"
        control={<Reading tool="lfs" output={status.bundled.lfs} missing="Not found" />}
        // With Git itself missing, the row above already says nothing will run.
        error={
          !gitMissing && status.bundled.lfs === null
            ? "Repositories that use Git LFS will fail to check out or push their LFS files. Reinstalling PwrGit restores it."
            : undefined
        }
      />
      {/* The caveat belongs to the pair, so it is said once, and in words that
          stay true when nothing is installed at all. */}
      <SettingsField
        label="Installed Git"
        sub="For reference only. PwrGit never runs an installed Git or Git LFS."
        control={<Reading tool="git" output={status.installed.git} missing="Not installed" />}
      />
      <SettingsField
        label="Installed Git LFS"
        control={<Reading tool="lfs" output={status.installed.lfs} missing="Not installed" />}
      />
    </div>
  );
}

export function GitRuntimeSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The probe is a pair of 5 s execs that can lose to a cold disk. Without a
  // way to ask again, one lost race left the card wrong until the Settings
  // window was reopened — so a failed read offers Try again, as About does.
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let disposed = false;
    setError(null);
    void dispatch("git:runtimeStatus", undefined)
      .then((result) => {
        if (disposed) return;
        if (result.ok) setStatus(result.value);
        else setError(result.error.message);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [request]);

  const chip = runtimeChip(status, error !== null);
  return (
    <SettingsSection
      eyebrow="Git"
      title="Git runtime"
      sectionId="git-runtime"
      description="PwrGit always runs its own bundled Git and Git LFS, so repository operations don’t depend on what’s installed on this machine."
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
        <GitRuntimeDetails status={status} />
      )}
    </SettingsSection>
  );
}
