import { useCallback, useEffect, useRef, useState } from "react";
import {
  changeRequestNoun,
  forgeAllHostsOff,
  forgeLabel,
  forgeProduct,
  type ForgeCapabilities,
  type ForgeStatus
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import {
  LOADING_READ_STATE,
  READY_READ_STATE,
  type ReadState
} from "../../state/readState";
import { ReadError } from "../shell/ReadError";
import {
  SettingsField,
  SettingsSection,
  settingsChipClass,
  type SettingsChipTone
} from "./SettingsLayout";

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
 * without reopening it — and so does flipping a switch in Hosts above, which is
 * an input to the same probe.
 *
 * This is a summary of the Hosts section above it, never a second opinion. Every
 * state below is read off `ForgeStatus.hosts`, the same per-host answers that
 * decide whether a transport spawns anything, so the two sections cannot
 * disagree: "Signed out" beside a host row that says "signed in as …" was the
 * bug, and it came from probing one hardcoded SaaS host per forge.
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

  const states = forges?.map((forge) => state(forge));
  const connected = states?.filter((current) => current === "connected").length;
  // Every forge deliberately switched off is a configuration, not a failure —
  // the header must not paint amber above rows that are all neutral "Off".
  const allOff =
    states !== undefined && states.length > 0 && states.every((c) => c === "off");

  return (
    <SettingsSection
      title="Forges"
      eyebrow="Integrations"
      description="A summary of the hosts above: what PwrGit can read through the CLI you already sign in with, and what each product is able to report. It never asks for a password or stores a token of its own."
      chip={
        loadState.status === "error" && forges === undefined
          ? "Unavailable"
          : forges === undefined
          ? undefined
          : allOff
            ? "All off"
            : connected === 0
              ? "None connected"
              : `${connected} connected`
      }
      chipKind={
        loadState.status === "error"
          ? "warn"
          : allOff
            ? "default"
            : connected === 0
              ? "warn"
              : "ok"
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
        forges?.map((forge, index) => {
          // Once per row: four call sites each deriving the state for themselves
          // is how they end up disagreeing about it.
          const current = states?.[index] ?? state(forge);
          return (
            <SettingsField
              key={forge.kind}
              label={forgeLabel(forge.kind)}
              sub={describe(forge, current)}
              control={
                // Same pill the section header uses — one state chip family in
                // the Settings window, not two that drift apart.
                <span
                  aria-label={`${forgeLabel(forge.kind)}: ${STATE_LABELS[current]}`}
                  aria-live="polite"
                  className={settingsChipClass(STATE_TONES[current])}
                  role="status"
                >
                  {STATE_LABELS[current]}
                </span>
              }
              help={remedyOrCapabilities(forge, current)}
            />
          );
        })
      )}
    </SettingsSection>
  );
}

/**
 * The four states a forge can be in, in the order they must be checked.
 *
 * `off` is the one that did not exist before and had to: a forge whose every
 * host the user switched off is neither connected nor signed out, and reporting
 * it as either sends them somewhere that cannot fix it — to a terminal to sign
 * in to something they are already signed in to, or nowhere at all while the
 * summary claims an ability the transport has given up.
 */
type ForgeState = "missing" | "connected" | "off" | "signedOut";

const STATE_LABELS: Record<ForgeState, string> = {
  missing: "Not installed",
  connected: "Connected",
  off: "Off",
  signedOut: "Signed out"
};

function state(forge: ForgeStatus): ForgeState {
  if (!forge.installed) return "missing";
  // `loggedIn` stays authoritative — main already derived it from the enabled
  // hosts, and re-deriving it here is how the two drift apart.
  if (forge.loggedIn) return "connected";
  if (forgeAllHostsOff(forge)) return "off";
  return "signedOut";
}

/**
 * One tone per state.
 *
 * `off` is neutral, not a warning: a host the user switched off is a working
 * configuration, and painting it amber would be the app second-guessing a choice
 * somebody made deliberately, next to the switch they made it with.
 *
 * Keyed on the state rather than re-read from `loggedIn`, so the chip's colour
 * and its label can never describe different states — reading `loggedIn` here
 * put an `installed: false` forge in a green pill labelled "Not installed".
 */
const STATE_TONES: Record<ForgeState, SettingsChipTone> = {
  missing: "warn",
  connected: "ok",
  off: "default",
  signedOut: "warn"
};

/** Name a few hosts, then count the rest — a row subtitle is a sentence, and
 *  `gh` can be signed in to a dozen Enterprise instances. Mirrors the cap
 *  `ownersPhrase` applies to the fork dialog's owner list. */
function hostsPhrase(hosts: string[]): string {
  if (hosts.length <= 3) return hosts.join(", ");
  return `${hosts.slice(0, 3).join(", ")} and ${hosts.length - 3} more`;
}

/** Enabled hosts that answered with a credential — what "Connected" is made of,
 *  and the only hosts this pane may claim anything about. */
function readableHosts(forge: ForgeStatus): string[] {
  return forge.hosts
    .filter((host) => host.enabled && host.loggedIn)
    .map((host) => host.host);
}

/** Hosts the user could sign in to: allowed by the switch, no credential yet. */
function awaitingSignIn(forge: ForgeStatus): string[] {
  return forge.hosts
    .filter((host) => host.enabled && !host.loggedIn)
    .map((host) => host.host);
}

/**
 * Which hosts this forge is actually being read from.
 *
 * Named rather than described, because the description was part of the problem:
 * "Merge requests on gitlab.com and self-managed instances" is a sentence about
 * the product, and it sat directly under a probe that had only ever asked
 * gitlab.com. Naming the hosts makes the claim checkable against the rows above.
 */
function describe(forge: ForgeStatus, current: ForgeState): string {
  const noun = `${changeRequestNoun(forge.kind)}s`;
  const readable = readableHosts(forge);
  if (readable.length > 0) {
    return `Reading ${noun} from ${hostsPhrase(readable)}.`;
  }
  if (current === "connected") {
    // Connected through the CLI's own default host, which has no row above and
    // so is not named here. Claiming "no host is signed in" beside a "Connected"
    // chip would be the two halves of this row contradicting each other.
    return `Reading ${noun} through the \`${forge.cli}\` CLI's default host.`;
  }
  if (current === "off") {
    return `Every ${forgeLabel(forge.kind)} host is switched off above.`;
  }
  // A missing CLI reports no hosts at all, so it lands here too — and saying
  // "no host is signed in" beside a "Not installed" chip blames the login for a
  // missing binary, which the remedy below correctly does not.
  if (current === "missing") {
    return `${forgeLabel(forge.kind)} ${noun} need the \`${forge.cli}\` CLI.`;
  }
  return `No host is signed in to read ${noun} from.`;
}

/**
 * A blocked forge gets the exact thing that unblocks it — install the CLI, sign
 * in, or turn a host back on. A working one lists what it can actually do, so a
 * missing feature reads as a known limit of that provider rather than a bug.
 */
function remedyOrCapabilities(forge: ForgeStatus, current: ForgeState): string {
  if (current === "missing") {
    return `Install the ${forgeLabel(forge.kind)} CLI (\`${forge.cli}\`) to see status here.`;
  }
  if (current === "off") {
    // Says what is actually true: no host is read and no token is minted. The
    // earlier wording claimed no `${forge.cli}` command runs at all, while the
    // probe spawns `--version` on every pass to learn the CLI is there — which
    // is how this row knows to say "Off" rather than "Not installed".
    return `Turn a host on in Hosts above to read ${changeRequestNoun(forge.kind)} status. PwrGit reads no host and mints no token while every host is off.`;
  }
  if (current === "signedOut") {
    return `Run \`${signInCommand(forge)}\` in a terminal, then this updates on its own.`;
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

/**
 * The sign-in command for a signed-out forge.
 *
 * The bare command authenticates the forge's SaaS host, so it is only right when
 * that host is one of the ones waiting. Otherwise it names a host explicitly —
 * `glab auth login` would send someone to gitlab.com when the instance they are
 * missing is a self-managed one, or when an env allowlist has switched gitlab.com
 * off entirely. With several waiting, the first is named: any of them moves the
 * state, and the Hosts section above owns the full per-row list.
 */
function signInCommand(forge: ForgeStatus): string {
  const waiting = awaitingSignIn(forge);
  if (waiting.length === 0 || waiting.includes(forgeProduct(forge.kind).saasHost)) {
    return `${forge.cli} auth login`;
  }
  return `${forge.cli} auth login --hostname ${waiting[0]}`;
}
