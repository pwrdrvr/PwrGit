import { useEffect, useRef, useState } from "react";
import type { GitRuntimeCandidate, GitRuntimeStatus } from "@pwrgit/shared";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { ReadError } from "../shell/ReadError";
import {
  GitSettingsProvider,
  useGitSettingsContext,
  type GitChoice,
  type GitSettingsState
} from "./GitSettingsContext";
import {
  PROBLEM_LABEL,
  SOURCE_LABEL,
  TRUST_LABEL,
  choiceFor,
  describeVersion,
  inUseCandidate,
  inUseChip
} from "./git-settings-view";
import { MetaParts } from "./GitMetaParts";
import { ManagedGitSection } from "./ManagedGitSection";
import { ManualPathInput } from "./ManualPathInput";
import { SettingsSwitch } from "./SettingsSwitch";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
  settingsChipClass,
  type SettingsFocusRequest
} from "./SettingsLayout";

export { describeVersion } from "./git-settings-view";

type Tool = "git" | "lfs";

/** One row's reading: the version in mono, then any machine detail (the tool's
 *  full output, the executable path) in the smaller mono About uses for URLs.
 *  A missing tool reads as absence, not as a value. */
export function Reading(props: {
  tool: Tool;
  output: string | null;
  missing: string;
  path?: string;
  /** What PwrGit proved about this Git, beside its version. */
  trust?: "signed" | "checksum" | undefined;
}) {
  const reading =
    props.output === null ? null : describeVersion(props.tool, props.output);
  return (
    <>
      {reading === null ? (
        <span className="settings-field__value settings-field__value--absent">
          {props.missing}
        </span>
      ) : props.trust === undefined ? (
        <span className="settings-field__value">{reading.version}</span>
      ) : (
        <span className="settings-git-version">
          <span className="settings-field__value">{reading.version}</span>
          <span className={settingsChipClass("ok")}>{TRUST_LABEL[props.trust]}</span>
        </span>
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

function rowParts(candidate: GitRuntimeCandidate): string[] {
  return [
    SOURCE_LABEL[candidate.source],
    candidate.trust === undefined ? null : TRUST_LABEL[candidate.trust],
    candidate.git === null ? null : describeVersion("git", candidate.git).version,
    candidate.lfs === null ? null : `LFS ${describeVersion("lfs", candidate.lfs).version}`,
    candidate.reflink?.checkout === true ? "Copy-on-write" : null
  ].filter((part) => part !== null);
}

function GitInstalls(props: {
  status: GitRuntimeStatus;
  busy: boolean;
  onSelect: (choice: GitChoice) => Promise<string | null>;
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
                <MetaParts parts={rowParts(candidate)} />
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
                    void props.onSelect(choiceFor(candidate)).then(setError);
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

/** Settings › Git › In use › Copy-on-write checkout. */
export type ReflinkCheckoutSetting = {
  enabled: boolean;
  saving: boolean;
  onChange: (enabled: boolean) => void;
};

/**
 * The switch is always drawn. With a Git that cannot clone it is off and
 * disabled, and the help names the Git that can — with a button that
 * chooses it when one was found here.
 */
function ReflinkCheckoutField(props: {
  status: GitRuntimeStatus;
  setting: ReflinkCheckoutSetting;
  busy: boolean;
  onSelect: (choice: GitChoice) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  const current = inUseCandidate(props.status);
  const capable = current?.reflink?.checkout === true;
  const offer = capable
    ? undefined
    : props.status.candidates.find((candidate) => candidate.problem === null && candidate.reflink?.checkout === true);
  const running =
    current?.git == null
      ? "The Git in use"
      : `The Git in use (${describeVersion("git", current.git).version}, ${SOURCE_LABEL[current.source]})`;
  const help = capable
    ? props.setting.enabled
      ? current?.reflink?.reshare === true
        ? "Checkout, switch, reset and new worktrees clone files the main checkout holds unchanged, so the copies take no extra space until one is edited. Maintenance › Clones re-shares worktrees that lost it. APFS, Btrfs and XFS; elsewhere files are written as usual."
        : "Checkout, switch, reset and new worktrees clone files the main checkout holds unchanged, so the copies take no extra space until one is edited. APFS, Btrfs and XFS; elsewhere files are written as usual."
      : "PwrGit writes every file as usual. A worktree created with --reflink elsewhere, or your own checkout.reflink config, still applies."
    : offer === undefined
      ? `Needs PwrGit’s Git (2.56.0-dev-pwrgit.1 or newer). ${running} can’t clone files, and no Git found here can.`
      : `Needs PwrGit’s Git. ${running} can’t clone files.`;
  return (
    <SettingsField
      label="Copy-on-write checkout"
      sub="Worktrees share unchanged files with the main checkout"
      control={
        <>
          <SettingsSwitch
            checked={capable && props.setting.enabled}
            disabled={!capable}
            busy={props.setting.saving}
            label="Copy-on-write checkout"
            onChange={props.setting.onChange}
          />
          <span className="settings-field__help">
            {help}
            {offer !== undefined ? (
              <>
                {" "}
                <button
                  aria-disabled={props.busy}
                  className="settings-inline-button"
                  type="button"
                  onClick={() => {
                    if (props.busy) return;
                    setError(null);
                    void props.onSelect(choiceFor(offer)).then(setError);
                  }}
                >
                  Use PwrGit’s Git
                </button>
              </>
            ) : null}
          </span>
        </>
      }
      error={error ?? undefined}
    />
  );
}

/** The In use card's fields: which Git runs, and whether it is healthy. */
function InUseDetails(props: {
  status: GitRuntimeStatus;
  busy: boolean;
  checking: boolean;
  onSelect: (choice: GitChoice) => Promise<string | null>;
  onRecheck: () => void;
  reflinkCheckout?: ReflinkCheckoutSetting | undefined;
}) {
  const { status } = props;
  const current = inUseCandidate(status);
  const active = status.active;
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
            trust={current?.trust}
          />
        }
        error={
          !gitMissing
            ? undefined
            : active === "bundled"
              ? "PwrGit can’t run its bundled Git, so repository operations will fail. Reinstalling PwrGit restores it."
              : active === "managed"
                ? "PwrGit can’t run the downloaded build it was told to use, so repository operations will fail. Choose another Git under Installs, or the bundled one."
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
            : active === "installed"
              ? "Repositories that use Git LFS will check out pointer files. Install Git LFS for this Git, or choose another."
              : "Repositories that use Git LFS will fail to check out or push their LFS files. Reinstalling PwrGit restores it."
        }
      />
      {/* Only PwrGit's own builds borrow a helper: an installed Git reads its
          own system config, keychain helper included. */}
      {platform === "darwin" && active !== "installed" ? (
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
              ? "PwrGit’s Git signs in to HTTPS remotes through the keychain helper of an installed Git, and none was found. Install Git from Homebrew or the Xcode Command Line Tools, or use an SSH remote."
              : "Borrowed from your installed Git, so the passwords it saved keep working."
          }
        />
      ) : null}
      {props.reflinkCheckout !== undefined ? (
        <ReflinkCheckoutField
          status={status}
          setting={props.reflinkCheckout}
          busy={props.busy}
          onSelect={props.onSelect}
        />
      ) : null}
      <div className="settings-field__actions settings-git-recheck">
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
    </div>
  );
}

/** The Installs card: every Git PwrGit can run, then a path it cannot find. */
function InstallsDetails(props: {
  status: GitRuntimeStatus;
  busy: boolean;
  onSelect: (choice: GitChoice) => Promise<string | null>;
}) {
  const { status } = props;
  return (
    <div className="settings-fields">
      <SettingsField
        label="Available"
        sub="Bundled, downloaded by PwrGit, or found on this machine. A Git needs Git LFS to be chosen."
        control={<GitInstalls status={status} busy={props.busy} onSelect={props.onSelect} />}
      />
      <SettingsField
        label="Custom path"
        sub="A Git the list does not find."
        control={
          <ManualPathInput
            executable="git"
            label="Custom Git path"
            saved={status.active === "installed" ? status.path : ""}
            saveLabel="Use path"
            disabled={props.busy}
            onSave={(path) => props.onSelect({ path })}
            onClear={() => props.onSelect({ path: null })}
          />
        }
      />
    </div>
  );
}

/**
 * Settings › Git's three cards, one per question: which Git runs (In use), is
 * there a newer verified build of PwrGit's own (PwrGit’s Git), and what else
 * could run (Installs). Outside a `GitSettingsProvider` (a test, a harness) it
 * brings its own.
 */
export function GitRuntimeSettings(props: GitCardsProps = {}) {
  const context = useGitSettingsContext();
  if (context === null) {
    return (
      <GitSettingsProvider>
        <GitCards {...props} />
      </GitSettingsProvider>
    );
  }
  return <GitCards {...props} />;
}

type GitCardsProps = {
  reflinkCheckout?: ReflinkCheckoutSetting;
  /** Settings › Updates, for a build that needs a newer PwrGit. */
  onOpenUpdates?: () => void;
};

function GitCards(props: GitCardsProps) {
  const git = useGitSettingsContext() as GitSettingsState;
  const { runtime, runtimeError, requestRuntime, managed, check } = git;

  // The probe is a handful of 5 s execs that can lose to a cold disk. The
  // window may already hold an answer (the nav asked); a pane that opens asks
  // again, so what it shows is never older than the visit.
  useEffect(() => {
    requestRuntime();
  }, [requestRuntime]);

  // One unforced release check per visit; main answers from its cache inside
  // the cooldown, so this costs the network at most every few hours.
  const checked = useRef(false);
  const supported = managed?.supported === true;
  useEffect(() => {
    if (!supported || checked.current) return;
    checked.current = true;
    void check(false);
  }, [supported, check]);

  const chip = inUseChip(runtime, runtimeError !== null);
  return (
    <>
      <SettingsSection
        eyebrow="Git"
        title="In use"
        sectionId="runtime"
        description="PwrGit runs its own Git and Git LFS, so repository operations don’t depend on what’s installed on this machine."
        chip={chip.label}
        chipKind={chip.tone}
      >
        {runtimeError !== null ? (
          <ReadError
            title="Git versions couldn’t be read"
            message={runtimeError}
            onRetry={requestRuntime}
          />
        ) : runtime === null ? (
          <p className="settings-empty" role="status">
            Checking Git versions…
          </p>
        ) : (
          <InUseDetails
            status={runtime}
            busy={git.selecting}
            checking={git.runtimeChecking}
            onSelect={git.select}
            onRecheck={requestRuntime}
            reflinkCheckout={props.reflinkCheckout}
          />
        )}
      </SettingsSection>
      <ManagedGitSection git={git} onOpenUpdates={props.onOpenUpdates} />
      <SettingsSection
        eyebrow="Git"
        title="Installs"
        sectionId="installs"
        description="Every Git PwrGit can run. A Git you choose here is used for every repository until you choose another."
      >
        {runtime === null ? (
          <p className="settings-empty">
            {runtimeError !== null ? "Git versions couldn’t be read." : "Checking Git versions…"}
          </p>
        ) : (
          <InstallsDetails status={runtime} busy={git.selecting} onSelect={git.select} />
        )}
      </SettingsSection>
    </>
  );
}

/** Settings › Git: the pane. */
export function GitSettings(props: GitCardsProps & { focusSection?: SettingsFocusRequest }) {
  const { focusSection, ...cards } = props;
  return (
    <SettingsSectionStack
      aria-label="Git settings"
      paneId="git"
      className="settings-stack--git"
      {...(focusSection === undefined ? {} : { focusSection })}
    >
      <SettingsPanelHead
        eyebrow="Git"
        title="Git"
        help="The Git and Git LFS PwrGit runs for every repository operation."
      />
      <GitRuntimeSettings {...cards} />
    </SettingsSectionStack>
  );
}
