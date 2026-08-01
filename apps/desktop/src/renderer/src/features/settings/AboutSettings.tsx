import { useState } from "react";
import type { AppDocumentKind } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection
} from "./SettingsLayout";

/** In-app access to the exact notice files bundled with this build. */
export function AboutSettings() {
  const [opening, setOpening] = useState<AppDocumentKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openDocument = async (kind: AppDocumentKind): Promise<void> => {
    setOpening(kind);
    setError(null);
    const result = await dispatch("app:openDocumentWindow", { kind });
    setOpening(null);
    if (!result.ok) setError(result.error.message);
  };

  return (
    <div className="settings-stack" aria-label="About PwrGit">
      <SettingsPanelHead
        eyebrow="About"
        title="About PwrGit"
        help="Open-source Git tools from PwrDrvr LLC."
      />

      <SettingsSection
        eyebrow="License"
        title="Attribution"
        description="Review the exact license documents packaged with this app build."
      >
        <div className="settings-fields">
          <SettingsField
            label="PwrGit license"
            sub="PwrGit is released under the MIT License."
            control={
              <button
                className="settings-button"
                disabled={opening !== null}
                type="button"
                onClick={() => {
                  void openDocument("license");
                }}
              >
                {opening === "license" ? "Opening…" : "View MIT license"}
              </button>
            }
          />
          <SettingsField
            label="Third-party notices"
            sub="Bundled npm, Electron, Git, Git LFS, and Git Credential Manager notices."
            control={
              <button
                className="settings-button"
                disabled={opening !== null}
                type="button"
                onClick={() => {
                  void openDocument("third-party-notices");
                }}
              >
                {opening === "third-party-notices"
                  ? "Opening…"
                  : "View third-party notices"}
              </button>
            }
            error={error ?? undefined}
          />
        </div>
      </SettingsSection>
    </div>
  );
}
