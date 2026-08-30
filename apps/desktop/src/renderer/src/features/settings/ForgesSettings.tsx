import { useCallback, useEffect, useRef, useState } from "react";
import type { ForgeCapabilities, ForgeStatus } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import {
  LOADING_READ_STATE,
  READY_READ_STATE,
  type ReadState
} from "../../state/readState";
import { ReadError } from "../shell/ReadError";
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
 * How often this pane asks main to re-examine its probe while it is open.
 *
 * Main answers most of these from cache without spawning anything: its TTL is
 * what decides when a real probe happens (a minute for a broken forge, five for
 * a working one). Something has to ask, though — main never probes on its own,
 * so without this tick `forge:statusChanged` would have nothing to announce and
 * a terminal-side `gh auth login` would never reach an open pane.
 */
const RECHECK_MS = 30_000;

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
  const [loadState, setLoadState] =
    useState<ReadState>(LOADING_READ_STATE);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const pushRef = useRef(0);

  const read = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    const startedAfterPush = pushRef.current;
    // Keep a usable status list in place during its ordinary 30-second probe.
    // Initial reads and retries still say plainly that work is in progress.
    setLoadState((current) =>
      current.status === "ready" ? current : LOADING_READ_STATE
    );
    const result = await dispatch("forge:status", undefined);
    if (
      !mountedRef.current ||
      request !== requestRef.current ||
      pushRef.current !== startedAfterPush
    ) {
      return;
    }
    if (result.ok) {
      setForges(result.value.forges);
      setLoadState(READY_READ_STATE);
    } else {
      setLoadState({ status: "error", message: result.error.message });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = subscribe("forge:statusChanged", ({ forges: next }) => {
      // A push is newer than every read currently in flight. Invalidating the
      // request also prevents a late failure from replacing this success.
      pushRef.current += 1;
      requestRef.current += 1;
      setForges(next);
      setLoadState(READY_READ_STATE);
    });
    void read();
    const timer = window.setInterval(() => void read(), RECHECK_MS);
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [read]);

  const connected = forges?.filter((forge) => forge.loggedIn).length;

  return (
    <SettingsSection
      title="Forges"
      eyebrow="Integrations"
      description="PwrGit reads pull and merge request status through the CLI you already sign in with. It never asks for a password or stores a token of its own."
      chip={
        loadState.status === "error" && forges === undefined
          ? "Unavailable"
          : forges === undefined
          ? undefined
          : connected === 0
            ? "None connected"
            : `${connected} connected`
      }
      chipKind={
        loadState.status === "error" || connected === 0 ? "warn" : "ok"
      }
    >
      {loadState.status === "error" && (
        <ReadError
          title="Forge connections couldn’t be checked"
          message={loadState.message}
          onRetry={() => void read()}
        />
      )}
      {forges === undefined && loadState.status !== "error" ? (
        <SettingsField
          label="Checking…"
          control={<span className="settings-card__chip">Probing</span>}
        />
      ) : forges?.length === 0 ? (
        <p className="settings-empty">No forge integrations are available.</p>
      ) : (
        forges?.map((forge) => (
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
