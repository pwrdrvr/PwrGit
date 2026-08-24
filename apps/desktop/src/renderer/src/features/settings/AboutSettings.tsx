import { useEffect, useState } from "react";
import {
  PWRGIT_LINKS,
  type AppDocumentKind,
  type AppIdentity,
  type PwrGitLinkName
} from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { dispatch } from "../../lib/pwrgit";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection
} from "./SettingsLayout";

type ProductResource = {
  key: PwrGitLinkName;
  label: string;
  sub: string;
  openLabel: string;
};

const RESOURCES: ProductResource[] = [
  {
    key: "documentation",
    label: "Documentation",
    sub: "Setup, feature reference, settings, and troubleshooting guidance.",
    openLabel: "Open documentation"
  },
  {
    key: "website",
    label: "PwrGit website",
    sub: "Product overview and current downloads.",
    openLabel: "Open website"
  },
  {
    key: "releases",
    label: "Releases",
    sub: "Release notes and downloadable desktop builds.",
    openLabel: "Open releases"
  },
  {
    key: "source",
    label: "Source code",
    sub: "PwrGit source, contribution guidance, and project history.",
    openLabel: "View source"
  }
];

const SUPPORT: ProductResource[] = [
  {
    key: "issues",
    label: "Report an issue",
    sub: "Use the public tracker for reproducible bugs and focused feature requests. Review and sanitize diagnostics before posting.",
    openLabel: "Open issue tracker"
  },
  {
    key: "security",
    label: "Security reporting",
    sub: "Do not post vulnerabilities publicly. Follow the private reporting instructions, and never include secrets, tokens, private repository contents, or personal data.",
    openLabel: "Open private reporting guidance"
  }
];

function releaseName(identity: AppIdentity): string {
  const train = identity.release.train === "stable" ? "Stable" : "Beta";
  const track =
    identity.release.channel === "latest" ? "Latest" : "Prerelease";
  return `${train} · ${track}`;
}

function ResourceActions(props: {
  resource: ProductResource;
  opening: boolean;
  feedback?: { kind: "status" | "error"; message: string };
  onOpen: () => void;
  onCopy: () => void;
}) {
  const url = PWRGIT_LINKS[props.resource.key];
  return (
    <div className="about-resource-actions">
      <div className="about-resource-actions__buttons">
        <button
          className="settings-button"
          disabled={props.opening}
          type="button"
          onClick={props.onOpen}
        >
          {props.opening ? "Opening…" : props.resource.openLabel}
        </button>
        <button
          aria-label={`Copy ${props.resource.label} address`}
          className="settings-button"
          type="button"
          onClick={props.onCopy}
        >
          Copy address
        </button>
      </div>
      <code className="about-resource-url">{url}</code>
      {props.feedback === undefined ? null : (
        <span
          className={
            props.feedback.kind === "error"
              ? "about-feedback about-feedback--error"
              : "about-feedback"
          }
          role={props.feedback.kind === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {props.feedback.message}
        </span>
      )}
    </div>
  );
}

/** Product identity, support, source, and exact bundled legal documents. */
export function AboutSettings() {
  const [identity, setIdentity] = useState<AppIdentity | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [identityRequest, setIdentityRequest] = useState(0);
  const [openingDocument, setOpeningDocument] =
    useState<AppDocumentKind | null>(null);
  const [documentError, setDocumentError] = useState<{
    kind: AppDocumentKind;
    message: string;
  } | null>(null);
  const [openingLink, setOpeningLink] = useState<PwrGitLinkName | null>(null);
  const [linkErrors, setLinkErrors] = useState<
    Partial<Record<PwrGitLinkName, string>>
  >({});
  const [feedback, setFeedback] = useState<{
    key: PwrGitLinkName | "diagnostics";
    kind: "status" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    let canceled = false;
    setIdentityError(null);
    void dispatch("app:readIdentity", undefined)
      .then((result) => {
        if (canceled) return;
        if (result.ok) {
          setIdentity(result.value);
          return;
        }
        setIdentityError(
          `Build details are unavailable: ${result.error.message}. Open Help → Logs for more information.`
        );
      })
      .catch((cause: unknown) => {
        if (canceled) return;
        setIdentityError(
          `Build details are unavailable: ${cause instanceof Error ? cause.message : String(cause)}. Open Help → Logs for more information.`
        );
      });
    return () => {
      canceled = true;
    };
  }, [identityRequest]);

  const openDocument = async (kind: AppDocumentKind): Promise<void> => {
    setOpeningDocument(kind);
    setDocumentError(null);
    try {
      const result = await dispatch("app:openDocumentWindow", { kind });
      if (!result.ok) {
        setDocumentError({ kind, message: result.error.message });
      }
    } catch (cause) {
      setDocumentError({
        kind,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    } finally {
      setOpeningDocument(null);
    }
  };

  const openResource = async (resource: ProductResource): Promise<void> => {
    setOpeningLink(resource.key);
    setFeedback(null);
    setLinkErrors((current) => ({ ...current, [resource.key]: undefined }));
    try {
      const result = await dispatch("shell:openExternal", {
        url: PWRGIT_LINKS[resource.key]
      });
      if (!result.ok) {
        setLinkErrors((current) => ({
          ...current,
          [resource.key]: `Couldn’t open ${resource.label.toLowerCase()}. Copy the address and try again when you’re online. ${result.error.message}`
        }));
      }
    } catch (cause) {
      setLinkErrors((current) => ({
        ...current,
        [resource.key]: `Couldn’t open ${resource.label.toLowerCase()}. Copy the address and try again when you’re online. ${cause instanceof Error ? cause.message : String(cause)}`
      }));
    } finally {
      setOpeningLink(null);
    }
  };

  const copyValue = async (
    key: PwrGitLinkName | "diagnostics",
    label: string,
    value: string
  ): Promise<void> => {
    try {
      await copyText(value);
      setFeedback({ key, kind: "status", message: `${label} copied.` });
    } catch (cause) {
      setFeedback({
        key,
        kind: "error",
        message: `Couldn’t copy ${label.toLowerCase()}: ${cause instanceof Error ? cause.message : String(cause)}`
      });
    }
  };

  const renderResources = (resources: ProductResource[]) =>
    resources.map((resource) => (
      <SettingsField
        key={resource.key}
        label={resource.label}
        sub={resource.sub}
        control={
          <ResourceActions
            resource={resource}
            opening={openingLink === resource.key}
            {...(feedback?.key === resource.key ? { feedback } : {})}
            onOpen={() => {
              void openResource(resource);
            }}
            onCopy={() => {
              void copyValue(
                resource.key,
                `${resource.label} address`,
                PWRGIT_LINKS[resource.key]
              );
            }}
          />
        }
        error={linkErrors[resource.key]}
      />
    ));

  return (
    <div className="settings-stack" aria-label="About PwrGit">
      <SettingsPanelHead
        eyebrow="About"
        title="About PwrGit"
        help="Open-source Git tools from PwrDrvr LLC. Build identity and first-party support links remain available from inside the app."
      />

      <SettingsSection
        eyebrow="Identity"
        title="This build"
        description="Runtime facts come from the desktop main process, not browser or renderer guesses."
        chip={
          identity === null
            ? undefined
            : identity.buildType === "packaged"
              ? "Packaged"
              : "Development"
        }
      >
        {identity === null ? (
          <div className="about-identity-state">
            {identityError === null ? (
              <p role="status">Loading build details…</p>
            ) : (
              <>
                <p role="alert">{identityError}</p>
                <button
                  className="settings-button"
                  type="button"
                  onClick={() => setIdentityRequest((request) => request + 1)}
                >
                  Retry
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="settings-fields">
            <SettingsField
              label="Version"
              control={
                <code className="about-identity-value">v{identity.version}</code>
              }
            />
            <SettingsField
              label="Release channel"
              sub="Derived from the installed binary, independent of your update preference."
              control={
                <span className="about-identity-value">
                  {releaseName(identity)}
                </span>
              }
            />
            <SettingsField
              label="Build type"
              control={
                <span className="about-identity-value">
                  {identity.buildType === "packaged"
                    ? "Packaged application"
                    : "Development build"}
                </span>
              }
            />
            <SettingsField
              label="Platform"
              control={
                <span className="about-identity-value">
                  {identity.platform.name} {identity.platform.version} (
                  {identity.platform.arch})
                </span>
              }
            />
            <SettingsField
              label="Runtime"
              control={
                <span className="about-identity-value">
                  Electron {identity.electronVersion}
                </span>
              }
            />
            <SettingsField
              label="Diagnostics identity"
              sub="Contains only the build facts above. Review it before adding it to a report."
              help={
                feedback?.key === "diagnostics" ? (
                  <span
                    className={
                      feedback.kind === "error"
                        ? "about-feedback about-feedback--error"
                        : "about-feedback"
                    }
                    role={feedback.kind === "error" ? "alert" : "status"}
                    aria-live="polite"
                  >
                    {feedback.message}
                  </span>
                ) : undefined
              }
              control={
                <button
                  className="settings-button"
                  type="button"
                  onClick={() => {
                    void copyValue(
                      "diagnostics",
                      "Diagnostics identity",
                      identity.diagnosticsText
                    );
                  }}
                >
                  Copy diagnostics identity
                </button>
              }
            />
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        eyebrow="Product"
        title="Resources"
        description="These canonical addresses can be copied for later if a browser or network is unavailable."
      >
        <div className="settings-fields">{renderResources(RESOURCES)}</div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Support"
        title="Help and reporting"
        description="Use public issues for ordinary bugs. Potential vulnerabilities belong in the private security channel."
      >
        <div className="settings-fields">{renderResources(SUPPORT)}</div>
      </SettingsSection>

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
                disabled={openingDocument !== null}
                type="button"
                onClick={() => {
                  void openDocument("license");
                }}
              >
                {openingDocument === "license"
                  ? "Opening…"
                  : "View MIT license"}
              </button>
            }
            error={
              documentError?.kind === "license"
                ? documentError.message
                : undefined
            }
          />
          <SettingsField
            label="Third-party notices"
            sub="Bundled npm, Electron, Git, Git LFS, and Git Credential Manager notices."
            control={
              <button
                className="settings-button"
                disabled={openingDocument !== null}
                type="button"
                onClick={() => {
                  void openDocument("third-party-notices");
                }}
              >
                {openingDocument === "third-party-notices"
                  ? "Opening…"
                  : "View third-party notices"}
              </button>
            }
            error={
              documentError?.kind === "third-party-notices"
                ? documentError.message
                : undefined
            }
          />
        </div>
      </SettingsSection>

    </div>
  );
}
