// Settings → Updates: which published build PwrGit follows.
//
// Built around a FOUR-SLOT MATRIX rather than two stacked segmented controls
// (Stable|Beta over Latest|Prerelease). The two-control shape had a reporting
// bug baked into it: each control could only label itself with one slot, so
// the Beta button read "Beta — Unavailable" whenever `beta.latest` was empty,
// even while `beta.prerelease` held a shipped alpha one click away. Showing
// all four published versions at once removes the class of confusion — every
// tile states its own resolved version, whether or not it is selected, and an
// empty slot says WHY it is empty instead of going blank.
//
// The selection is still two independent axes on the wire (`updates.train` +
// `updates.channel`); a tile click writes both in one patch. Main derives
// `updates.selectionSource: "user"` from that write, which is what pins the
// pair against the version-derived inference — see `resolveUpdateSelection`
// in packages/shared/src/protocol.ts.

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import {
  UPDATE_CHANNELS,
  UPDATE_TRAINS,
  type AppSettingsSnapshot,
  type AppUpdateCheckResult,
  type AppUpdateReleaseInfo,
  type AppUpdateReleaseVersions,
  type UpdateChannel,
  type UpdateTrain
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { useAppUpdateStatus } from "../update/useAppUpdateStatus";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection
} from "./SettingsLayout";

const TRAIN_LABEL: Record<UpdateTrain, string> = {
  stable: "Stable",
  beta: "Beta"
};

const CHANNEL_LABEL: Record<UpdateChannel, string> = {
  latest: "Latest",
  prerelease: "Prerelease"
};

const SLOT_SUB: Record<`${UpdateTrain}:${UpdateChannel}`, string> = {
  "stable:latest": "Smoke-checked. The default for everyone.",
  "stable:prerelease": "Release candidates for the stable line.",
  "beta:latest": "Beta builds off main.",
  "beta:prerelease": "Newest alpha off main. May not install."
};

/** The four published slots in render order — trains as rows, tracks as
 *  columns — derived from the shared axis lists so the headers, the tiles and
 *  the arrow-key walk can never disagree about the grid's shape. */
const SLOT_ORDER: ReadonlyArray<{ train: UpdateTrain; channel: UpdateChannel }> =
  UPDATE_TRAINS.flatMap((train) =>
    UPDATE_CHANNELS.map((channel) => ({ train, channel }))
  );

const COLUMNS = UPDATE_CHANNELS.length;

/** Tag comparison for the "Installed" chip. Release tags carry a leading `v`;
 *  the identity version does not. */
function sameVersion(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.trim().replace(/^v/i, "") === b.trim().replace(/^v/i, "");
}

function updateResultText(result: AppUpdateCheckResult): string {
  if (result.status === "skipped") return result.reason;
  if (result.status === "error") {
    return `Update check failed: ${result.message}`;
  }
  if (result.status === "checking") return "Checking for updates…";
  if (result.status === "no-update") {
    return `You're up to date (v${result.version}).`;
  }
  if (result.status === "downloaded") {
    return `Update ready: v${result.version}. Restart to install.`;
  }
  return `Update available: v${result.version}. Downloading in the background.`;
}

function SlotTile(props: {
  train: UpdateTrain;
  channel: UpdateChannel;
  release: AppUpdateReleaseInfo | undefined;
  /** The release read is still in flight. Distinct from a slot that answered
   *  and has nothing — "Loading" and "Unavailable" are not the same claim. */
  loading: boolean;
  selected: boolean;
  installed: boolean;
  disabled: boolean;
  /** Roving tabindex: exactly one tile is in the tab order, per the
   *  radiogroup contract. `SLOT_ORDER` is what the arrows walk. */
  tabbable: boolean;
  onSelect: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  registerRef: (element: HTMLButtonElement | null) => void;
}) {
  const version = props.release?.version;
  const label = `${TRAIN_LABEL[props.train]} ${CHANNEL_LABEL[props.channel]}`;
  const headline = version ?? (props.loading ? "Loading…" : "Unavailable");
  const sub =
    version !== undefined
      ? SLOT_SUB[`${props.train}:${props.channel}`]
      : props.loading
        ? "Reading published releases."
        : // An empty slot explains itself rather than leaving the reader to
          // guess whether the feed broke or simply has nothing yet.
          (props.release?.unavailableReason ?? "Nothing published here yet.");
  return (
    <button
      ref={props.registerRef}
      aria-checked={props.selected}
      aria-label={`${label} — ${headline}`}
      className={`settings-slot${props.selected ? " is-selected" : ""}`}
      disabled={props.disabled}
      role="radio"
      tabIndex={props.tabbable ? 0 : -1}
      type="button"
      onClick={props.onSelect}
      onKeyDown={props.onKeyDown}
    >
      <span
        className={`settings-slot__version${
          version === undefined ? " is-empty" : ""
        }`}
      >
        {headline}
      </span>
      <span className="settings-slot__sub">{sub}</span>
      {props.selected || props.installed ? (
        <span className="settings-slot__chips">
          {props.selected ? (
            <span className="settings-slot__chip is-selected">Selected</span>
          ) : null}
          {props.installed ? (
            <span className="settings-slot__chip is-installed">Installed</span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/** Settings → Updates: the Stable|Beta × Latest|Prerelease release matrix. */
export function UpdatesSettings(props: {
  saving: boolean;
  snapshot: AppSettingsSnapshot;
  onSelectionChange: (next: {
    train: UpdateTrain;
    channel: UpdateChannel;
  }) => void;
}) {
  const [releaseVersions, setReleaseVersions] = useState<
    AppUpdateReleaseVersions | undefined
  >();
  // "Loading" is only true until the read ANSWERS. A dispatch that fails
  // still settles, and the tiles must fall through to Unavailable rather than
  // claim a read is in flight for the rest of the window's life.
  const [releasesSettled, setReleasesSettled] = useState(false);
  const [releasesError, setReleasesError] = useState<string | undefined>();
  const [appVersion, setAppVersion] = useState<string | undefined>();
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<
    AppUpdateCheckResult | undefined
  >();
  const {
    downloadedVersion,
    restarting: updateRestarting,
    restartError: updateRestartError,
    restart: handleRestartUpdate,
    setStatus: setUpdateStatus
  } = useAppUpdateStatus();

  const train = props.snapshot.updates.train;
  const channel = props.snapshot.updates.channel;
  const pinned = props.snapshot.updates.selectionSource === "user";

  useEffect(() => {
    let canceled = false;
    void (async () => {
      const [versions, identity] = await Promise.all([
        dispatch("app:readUpdateReleases", undefined),
        dispatch("app:readIdentity", undefined)
      ]);
      if (canceled) return;
      setReleasesSettled(true);
      if (versions.ok) {
        setReleaseVersions(versions.value);
        setReleasesError(undefined);
      } else {
        setReleasesError(versions.error.message);
      }
      if (identity.ok) setAppVersion(identity.value.version);
    })();
    return () => {
      canceled = true;
    };
  }, []);

  const handleCheckForUpdate = async (): Promise<void> => {
    setUpdateChecking(true);
    setUpdateResult(undefined);
    const result = await dispatch("app:checkForUpdate", undefined);
    if (result.ok) {
      setUpdateResult(result.value);
      setUpdateStatus(result.value);
      // The check revalidated the main-process release cache, so this read is
      // served from memory and clears any stale Unavailable slot labels.
      const versions = await dispatch("app:readUpdateReleases", undefined);
      setReleasesSettled(true);
      if (versions.ok) {
        setReleaseVersions(versions.value);
        setReleasesError(undefined);
      } else {
        setReleasesError(versions.error.message);
      }
    } else {
      setUpdateResult({ status: "error", message: result.error.message });
    }
    setUpdateChecking(false);
  };

  // Roving tabindex + arrow keys, the radiogroup contract. Focus moves and
  // selection does NOT follow it: picking a slot rewrites which build the app
  // installs, so a stray arrow press should not change the feed. The user
  // commits with Space/Enter (the button's own activation) or a click.
  const slotRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    SLOT_ORDER.findIndex(
      (slot) => slot.train === train && slot.channel === channel
    )
  );
  const handleSlotKeyDown = useCallback(
    (index: number) =>
      (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
        const delta =
          event.key === "ArrowRight"
            ? 1
            : event.key === "ArrowLeft"
              ? -1
              : event.key === "ArrowDown"
                ? COLUMNS
                : event.key === "ArrowUp"
                  ? -COLUMNS
                  : 0;
        if (delta === 0) return;
        event.preventDefault();
        const count = SLOT_ORDER.length;
        slotRefs.current[(index + delta + count) % count]?.focus();
      },
    []
  );

  return (
    <div className="settings-stack" aria-label="Update settings">
      <SettingsPanelHead
        eyebrow="Updates"
        title="Updates"
        help="Choose the release train and track. Website downloads follow the suffix of the installed binary until you pick a slot here."
      />

      <SettingsSection
        eyebrow="Updates"
        title="Release channel"
        description="Stable is the smoke-checked train. Beta follows main and stays selectable even when its versions are still Unavailable."
        chip={`${TRAIN_LABEL[train]} · ${CHANNEL_LABEL[channel]}`}
        chipKind={train === "beta" ? "warn" : "ok"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Follow this build"
            sub="Two trains, two tracks. Latest is smoke-checked within its train; Prerelease is newer and may not install."
            help={
              // The inference rule is only worth explaining while it is still
              // live — once somebody picks a slot, saying "we guessed" is noise.
              !pinned
                ? "Following the build you installed. Pick a slot to pin it."
                : undefined
            }
            error={
              releasesError !== undefined
                ? `Could not read published releases: ${releasesError}`
                : undefined
            }
            control={
              <div
                className="settings-slots"
                role="radiogroup"
                aria-label="Release channel"
              >
                {/* Header cells are decoration: every tile's aria-label
                    already spells out "Stable Latest", so exposing the headers
                    inside the radiogroup would only interleave duplicate text
                    with the options. */}
                <div className="settings-slots__row-header" aria-hidden="true" />
                {UPDATE_CHANNELS.map((headerChannel) => (
                  <div
                    key={headerChannel}
                    className="settings-slots__col-header"
                    aria-hidden="true"
                  >
                    {CHANNEL_LABEL[headerChannel]}
                  </div>
                ))}
                {UPDATE_TRAINS.map((rowTrain) => (
                  <Fragment key={rowTrain}>
                    <div
                      className="settings-slots__row-header"
                      aria-hidden="true"
                    >
                      {TRAIN_LABEL[rowTrain]}
                    </div>
                    {UPDATE_CHANNELS.map((slotChannel) => {
                      const index = SLOT_ORDER.findIndex(
                        (slot) =>
                          slot.train === rowTrain && slot.channel === slotChannel
                      );
                      const release = releaseVersions?.[rowTrain]?.[slotChannel];
                      return (
                        <SlotTile
                          key={slotChannel}
                          train={rowTrain}
                          channel={slotChannel}
                          release={release}
                          loading={!releasesSettled}
                          selected={index === selectedIndex}
                          installed={sameVersion(release?.version, appVersion)}
                          disabled={props.saving}
                          tabbable={index === selectedIndex}
                          onSelect={() => {
                            props.onSelectionChange({
                              train: rowTrain,
                              channel: slotChannel
                            });
                          }}
                          onKeyDown={handleSlotKeyDown(index)}
                          registerRef={(element) => {
                            slotRefs.current[index] = element;
                          }}
                        />
                      );
                    })}
                  </Fragment>
                ))}
              </div>
            }
          />
          <SettingsField
            label="Check now"
            sub="PwrGit also checks on its own. This asks immediately."
            help={
              updateResult ? (
                <span
                  className={
                    updateResult.status === "error"
                      ? "settings-update-channel__result settings-update-channel__result--error"
                      : "settings-update-channel__result"
                  }
                  role={updateResult.status === "error" ? "alert" : undefined}
                >
                  {updateResultText(updateResult)}
                </span>
              ) : undefined
            }
            control={
              <div className="settings-update-channel">
                {downloadedVersion ? (
                  <div className="settings-update-channel__restart">
                    <button
                      aria-label={`Restart to Update (${downloadedVersion})`}
                      className="settings-button settings-button--primary"
                      type="button"
                      disabled={updateRestarting}
                      onClick={() => {
                        void handleRestartUpdate();
                      }}
                    >
                      Restart to Update ({downloadedVersion})
                    </button>
                    {updateRestartError ? (
                      <span
                        className="settings-update-channel__result settings-update-channel__result--error"
                        role="alert"
                      >
                        {updateRestartError}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <button
                  className="settings-button"
                  type="button"
                  disabled={props.saving || updateChecking}
                  onClick={() => {
                    void handleCheckForUpdate();
                  }}
                >
                  {updateChecking ? "Checking…" : "Check for Update"}
                </button>
              </div>
            }
          />
        </div>
      </SettingsSection>
    </div>
  );
}
