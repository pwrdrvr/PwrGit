import { useEffect, useState } from "react";
import type { ForgeCapabilities, ForgeStatus } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { SettingsField, SettingsSection } from "./SettingsLayout";

const FORGE_LABELS: Record<ForgeStatus["kind"], string> = {
  github: "GitHub",
  gitlab: "GitLab"
};

/** What each capability buys the user, in their words rather than the API's. */
const CAPABILITY_LABELS: Record<keyof ForgeCapabilities, string> = {
  batchedBranchLookup: "Branch status in bulk",
  batchedCommitAssociation: "Commit links in bulk",
  changeSizeAndTimeline: "Diff size and timeline",
  forkDefaultBranchOnly: "Fork just the default branch",
  commitAuthorIdentity: "Commit author avatars"
};

/**
 * Which forges PwrGit can read right now, and what each one can do.
 *
 * Everything here comes from main's cached probe over `forge:status`; this pane
 * never shells a CLI or calls a forge itself. Main pushes `forge:statusChanged`
 * when availability changes, so signing in from a terminal updates this pane
 * without reopening it.
 */
export function ForgesSettings() {
  const [forges, setForges] = useState<ForgeStatus[] | undefined>();

  useEffect(() => {
    let canceled = false;
    let receivedEvent = false;
    const unsubscribe = subscribe("forge:statusChanged", ({ forges: next }) => {
      receivedEvent = true;
      setForges(next);
    });
    // A pushed change always wins: the read below may have been in flight while
    // the user was signing in, and landing it late would show stale state.
    void dispatch("forge:status", undefined).then((result) => {
      if (!canceled && !receivedEvent && result.ok) setForges(result.value.forges);
    });
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, []);

  const connected = forges?.filter((forge) => forge.loggedIn).length;

  return (
    <SettingsSection
      title="Forges"
      eyebrow="Integrations"
      description="PwrGit reads pull and merge request status through the CLI you already sign in with. It never asks for a password or stores a token of its own."
      chip={
        forges === undefined
          ? undefined
          : connected === 0
            ? "None connected"
            : `${connected} connected`
      }
      chipKind={connected === undefined || connected > 0 ? "ok" : "warn"}
    >
      {forges === undefined ? (
        <SettingsField
          label="Checking…"
          control={<span className="settings-card__chip">Probing</span>}
        />
      ) : (
        forges.map((forge) => (
          <SettingsField
            key={forge.kind}
            label={FORGE_LABELS[forge.kind]}
            sub={describe(forge)}
            control={
              // Same pill the section header uses — one state chip family in
              // the Settings window, not two that drift apart.
              <span
                className={`settings-card__chip settings-card__chip--${tone(forge)}`}
              >
                {state(forge)}
              </span>
            }
            help={remedyOrCapabilities(forge)}
          />
        ))
      )}
    </SettingsSection>
  );
}

function state(forge: ForgeStatus): string {
  if (!forge.installed) return "Not installed";
  return forge.loggedIn ? "Connected" : "Signed out";
}

function tone(forge: ForgeStatus): "ok" | "warn" {
  return forge.loggedIn ? "ok" : "warn";
}

function describe(forge: ForgeStatus): string {
  return forge.kind === "github"
    ? "Pull requests on github.com."
    : "Merge requests on gitlab.com and self-managed instances.";
}

/**
 * A blocked forge gets the exact command that unblocks it; a working one lists
 * what it can actually do, so a missing feature reads as a known limit of that
 * provider rather than as a bug.
 */
function remedyOrCapabilities(forge: ForgeStatus): string {
  if (!forge.installed) {
    return `Install the ${FORGE_LABELS[forge.kind]} CLI (\`${forge.cli}\`) to see status here.`;
  }
  if (!forge.loggedIn) {
    return `Run \`${forge.cli} auth login\` in a terminal, then this updates on its own.`;
  }
  const supported = (
    Object.keys(CAPABILITY_LABELS) as (keyof ForgeCapabilities)[]
  ).filter((capability) => forge.capabilities[capability]);
  const missing = (
    Object.keys(CAPABILITY_LABELS) as (keyof ForgeCapabilities)[]
  ).filter((capability) => !forge.capabilities[capability]);
  const supportedText = supported
    .map((capability) => CAPABILITY_LABELS[capability])
    .join(" · ");
  const missingText =
    missing.length === 0
      ? ""
      : `Not supported by this forge: ${missing
          .map((capability) => CAPABILITY_LABELS[capability].toLowerCase())
          .join(", ")}.`;
  // Either half may be empty; joining only the present ones keeps a stray
  // leading ". " out of the hint.
  return [supportedText, missingText].filter((part) => part !== "").join(". ");
}
