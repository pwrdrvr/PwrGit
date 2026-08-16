import { useEffect, useState } from "react";
import type {
  AppSettingsSnapshot,
  AppUpdateCheckResult,
  AppUpdateReleaseInfo,
  AppUpdateReleaseVersions,
  AppUpdateStatus,
  UpdateChannel,
  UpdateTrain
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSegmented
} from "./SettingsLayout";

const TRAINS: Array<{ value: UpdateTrain; label: string }> = [
  { value: "stable", label: "Stable" },
  { value: "beta", label: "Beta" }
];

const TRACKS: Array<{ value: UpdateChannel; label: string }> = [
  { value: "latest", label: "Latest" },
  { value: "prerelease", label: "Prerelease" }
];

function releaseVersionText(release: AppUpdateReleaseInfo | undefined): string {
  return release?.version ?? "Unavailable";
}

function releaseHelpText(
  releases: AppUpdateReleaseVersions | undefined
): string {
  if (!releases) return "Release versions are loading.";
  return [
    `Stable latest: ${releaseVersionText(releases.stable.latest)}`,
    `Stable prerelease: ${releaseVersionText(releases.stable.prerelease)}`,
    `Beta latest: ${releaseVersionText(releases.beta.latest)}`,
    `Beta prerelease: ${releaseVersionText(releases.beta.prerelease)}`
  ].join(". ");
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

/** Settings → Updates: Stable|Beta train and Latest|Prerelease track. */
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
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<
    AppUpdateCheckResult | undefined
  >();
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({
    status: "idle"
  });
  const [updateRestarting, setUpdateRestarting] = useState(false);
  const [updateRestartError, setUpdateRestartError] = useState<
    string | undefined
  >();

  const train = props.snapshot.updates.train;
  const channel = props.snapshot.updates.channel;

  useEffect(() => {
    let canceled = false;
    void dispatch("app:readUpdateReleases", undefined).then((result) => {
      if (!canceled && result.ok) setReleaseVersions(result.value);
    });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    let canceled = false;
    let receivedEvent = false;
    const unsubscribe = subscribe("app:updateStatus", (status) => {
      receivedEvent = true;
      setUpdateStatus(status);
      if (status.status === "downloaded") {
        setUpdateRestartError(undefined);
        setUpdateRestarting(false);
      }
    });
    void dispatch("app:readUpdateStatus", undefined).then((result) => {
      if (!canceled && !receivedEvent && result.ok) {
        setUpdateStatus(result.value);
      }
    });
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, []);

  const downloadedVersion =
    updateStatus.status === "downloaded" ? updateStatus.version : undefined;

  const handleCheckForUpdate = async (): Promise<void> => {
    setUpdateChecking(true);
    setUpdateResult(undefined);
    const result = await dispatch("app:checkForUpdate", undefined);
    if (result.ok) {
      setUpdateResult(result.value);
      setUpdateStatus(result.value);
    } else {
      setUpdateResult({ status: "error", message: result.error.message });
    }
    setUpdateChecking(false);
  };

  const handleRestartUpdate = async (): Promise<void> => {
    setUpdateRestarting(true);
    setUpdateRestartError(undefined);
    const result = await dispatch("app:installUpdate", undefined);
    if (!result.ok) {
      setUpdateRestartError(result.error.message);
      setUpdateRestarting(false);
      return;
    }
    if (result.value.status === "error") {
      setUpdateRestartError(result.value.message);
      setUpdateRestarting(false);
    }
  };

  return (
    <div className="settings-stack" aria-label="Update settings">
      <SettingsPanelHead
        eyebrow="Updates"
        title="Updates"
        help="Choose the release train and track. Website downloads follow the suffix of the installed binary until you save a choice here."
      />

      <SettingsSection
        eyebrow="Updates"
        title="Release train"
        description="Stable is the smoke-checked train. Beta follows main and stays selectable even when its versions are still Unavailable."
        chip={train === "beta" ? "Beta" : "Stable"}
        chipKind={train === "beta" ? "warn" : "ok"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Release channel"
            sub="Stable is the 1.0 feed. Beta is the next main-train build."
            help={releaseHelpText(releaseVersions)}
            control={
              <SettingsSegmented
                aria-label="Release channel"
                disabled={props.saving}
                options={TRAINS.map((option) => ({
                  ...option,
                  meta: releaseVersionText(
                    releaseVersions?.[option.value]?.latest
                  )
                }))}
                value={train}
                onChange={(next) => {
                  props.onSelectionChange({ train: next, channel });
                }}
              />
            }
          />
          <SettingsField
            label="Update track"
            sub="Latest is smoke-checked. Prerelease is newer and may not install."
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
                <SettingsSegmented
                  aria-label="Update track"
                  disabled={props.saving}
                  options={TRACKS.map((option) => ({
                    ...option,
                    meta: releaseVersionText(
                      releaseVersions?.[train]?.[option.value]
                    )
                  }))}
                  value={channel}
                  onChange={(next) => {
                    props.onSelectionChange({ train, channel: next });
                  }}
                />
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
