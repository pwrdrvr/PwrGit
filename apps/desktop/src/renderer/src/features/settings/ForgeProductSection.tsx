import type { ReactNode } from "react";
import {
  changeRequestNoun,
  forgeAllHostsOff,
  forgeProduct,
  type ForgeCapabilities,
  type ForgeHostConfig,
  type ForgeHostRow,
  type ForgeKind,
  type ForgeStatus
} from "@pwrgit/shared";
import {
  SettingsField,
  SettingsSection,
  settingsChipClass,
  type SettingsChipTone
} from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

/** What each capability buys the user, in their words rather than the API's. */
const CAPABILITY_LABELS: Record<keyof ForgeCapabilities, string> = {
  batchedBranchLookup: "Branch status in bulk",
  batchedCommitAssociation: "Commit links in bulk",
  changeSizeAndTimeline: "Diff size and timeline",
  forkDefaultBranchOnly: "Fork just the default branch",
  commitAuthorIdentity: "Commit author avatars"
};

/**
 * The states a product can be in, in the order they must be checked.
 *
 * `off` is the one that had to exist: a forge whose every host the user
 * switched off is neither connected nor signed out, and reporting it as either
 * sends them somewhere that cannot fix it — to a terminal to sign in to
 * something they are already signed in to, or nowhere at all while the summary
 * claims an ability the transport has given up.
 *
 * `unknown` is the probe not having answered yet. It is not a state the forge
 * is in, which is why it paints no chip rather than a neutral one.
 */
export type ForgeProductState =
  | "unknown"
  | "missing"
  | "connected"
  | "off"
  | "signedOut";

const STATE_LABELS: Record<Exclude<ForgeProductState, "unknown">, string> = {
  missing: "Not installed",
  connected: "Connected",
  off: "Off",
  signedOut: "Signed out"
};

/**
 * One tone per state.
 *
 * `off` is neutral, not a warning: a host the user switched off is a working
 * configuration, and painting it amber would be the app second-guessing a
 * choice somebody made deliberately, next to the switch they made it with.
 *
 * Keyed on the state rather than re-read from `loggedIn`, so the chip's colour
 * and its label can never describe different states — reading `loggedIn` here
 * put an `installed: false` forge in a green pill labelled "Not installed".
 */
const STATE_TONES: Record<
  Exclude<ForgeProductState, "unknown">,
  SettingsChipTone
> = {
  missing: "warn",
  connected: "ok",
  off: "default",
  signedOut: "warn"
};

/** One product's state as a sentence, for the pane's live region. */
export function forgeStateSentence(
  kind: ForgeKind,
  state: ForgeProductState
): string | null {
  if (state === "unknown") return null;
  return `${forgeProduct(kind).label}: ${STATE_LABELS[state]}`;
}

export function forgeProductState(
  status: ForgeStatus | undefined
): ForgeProductState {
  if (status === undefined) return "unknown";
  if (!status.installed) return "missing";
  // `loggedIn` stays authoritative — main already derived it from the enabled
  // hosts, and re-deriving it here is how the two drift apart.
  if (status.loggedIn) return "connected";
  if (forgeAllHostsOff(status)) return "off";
  return "signedOut";
}

/**
 * One product's section of Settings → Forges: its hosts, its way in, and the
 * two questions only a product can answer.
 *
 * The section is what carries the product, so nothing inside it repeats the
 * name: a row's sub-line says "signed in as octo-dev", not
 * "GitHub · signed in as octo-dev". That prefix existed because the list used
 * to interleave both products, sorted by hostname, directly above a card that
 * separated them.
 *
 * Capabilities live here rather than on a host row for the reason
 * `forge/AGENTS.md` gives: per host they would repeat the same sentence once
 * per instance, and a product whose CLI is missing has no host rows at all to
 * carry them. A per-product section is the home that objection asks for — it
 * exists whether or not the product has a single host.
 */
export function ForgeProductSection(props: {
  kind: ForgeKind;
  /** This product's rows, already filtered. `undefined` until the list loads. */
  hosts: ForgeHostRow[] | undefined;
  /** This product's probe. `undefined` until it answers. */
  status: ForgeStatus | undefined;
  /** A write is in flight, or the pane is saving. Controls are refused, not
   *  disabled — see the switch below. */
  blocked: boolean;
  /** The host list has not loaded yet, so Add is genuinely unavailable. */
  loading: boolean;
  copied: string | undefined;
  rowError: { host: string; message: string } | undefined;
  onWrite: (row: ForgeHostRow, value: ForgeHostConfig | null) => void;
  onCopy: (row: ForgeHostRow) => void;
  onAdd: () => void;
}) {
  const { kind, hosts, status } = props;
  const state = forgeProductState(status);
  const { label, cli, addHost } = forgeProduct(kind);
  const rows = hosts ?? [];

  return (
    <SettingsSection
      // Stable across every state, so a fold survives a probe landing.
      sectionId={kind}
      title={label}
      eyebrow="Integrations"
      description={describeProduct(kind, status, rows, state)}
      // Spread rather than passed as undefined: `exactOptionalPropertyTypes`
      // distinguishes "absent" from "present and undefined", and an unprobed
      // product has no chip at all rather than an empty one.
      {...(state === "unknown"
        ? {}
        : {
            // No `role="status"` / `aria-live` here: this lands inside the
            // disclosure header's `role="button"`, whose children ARIA treats
            // as presentational, so a live region nested in it never fires.
            // The section wires the chip in as the header's description, and
            // the pane announces the CHANGE from its own live region below.
            chip: (
              <span aria-label={`${label}: ${STATE_LABELS[state]}`}>
                {STATE_LABELS[state]}
              </span>
            ),
            chipKind: STATE_TONES[state]
          })}
    >
      {props.hosts === undefined ? (
        <SettingsField
          label="Checking…"
          control={<span className={settingsChipClass()}>Reading</span>}
        />
      ) : rows.length === 0 ? (
        <p className="settings-empty">{emptyNote(kind, state)}</p>
      ) : (
        rows.map((row) => (
          <SettingsField
            key={row.host}
            label={row.host}
            sub={describeRow(row)}
            control={
              <SettingsSwitch
                checked={row.enabled}
                // In-flight is aria-disabled, never disabled: Chromium blurs a
                // disabled element, throwing keyboard focus to <body> for the
                // length of the operation. The handler is guarded instead.
                busy={props.blocked}
                label={`Read ${label} status from ${row.host}`}
                onChange={(next) => {
                  if (props.blocked) return;
                  // Always write the value the user asked for. An earlier
                  // version cleared the entry instead, on the theory that
                  // clearing returns the host to its derived default — but the
                  // derived default can BE the value they are trying to leave,
                  // in which case the switch silently snapped back and the host
                  // could not be turned off at all.
                  props.onWrite(row, { enabled: next });
                }}
              />
            }
            error={
              props.rowError?.host === row.host
                ? props.rowError.message
                : undefined
            }
            help={
              <>
                {/* Two independent questions, and conflating them was a bug.
                    `origin` says whether a CLI holds an account here, which is
                    what earns the sign-in command. `kindSource` says whether a
                    PERSON chose the product, which is what makes the host
                    removable. Gating both on `origin` put "Added by you" and a
                    Remove button on a host the user had merely switched off —
                    and removing it there cleared the `enabled:false`, turning
                    the host back ON and dropping the row that could undo it. */}
                {row.origin === "config" ? (
                  <span>
                    <code>{row.cli}</code> holds no account for this host yet —
                    run <code>{signInCommand(row)}</code>
                  </span>
                ) : (
                  <span>{sourceNote(row)}</span>
                )}
                {/* An env-pinned or switched-off row still needs its
                    explanation; `sourceNote` used to be unreachable for every
                    config row, so the switch that cannot move said nothing
                    about why. */}
                {row.origin === "config" && row.enabledSource !== "auto" ? (
                  <span>{sourceNote(row)}</span>
                ) : null}
                {row.origin === "config" || row.kindSource === "config" ? (
                  <span className="settings-field__actions">
                    {row.origin === "config" ? (
                      <button
                        className="settings-inline-button"
                        type="button"
                        onClick={() => props.onCopy(row)}
                      >
                        {props.copied === row.host ? "Copied" : "Copy command"}
                      </button>
                    ) : null}
                    {row.kindSource === "config" ? (
                      /* "Remove host", not "Remove": it sits beside a command
                         the button above copies, and bare "Remove" reads as if
                         it might take the command or the account instead. The
                         label names the host so several rows are
                         distinguishable, and keeps the visible text as its
                         prefix (SC 2.5.3). */
                      <button
                        aria-disabled={props.blocked}
                        aria-label={`Remove host ${row.host}`}
                        className="settings-inline-button"
                        type="button"
                        onClick={() => {
                          if (props.blocked) return;
                          // `null` clears the entry, and for a hand-added host
                          // the stored kind is the only thing naming its
                          // product — so the row goes rather than lingering as
                          // an unknown forge. Safe to offer without
                          // confirmation only because `kindSource` proves there
                          // is a chosen product to withdraw.
                          props.onWrite(row, null);
                        }}
                      >
                        Remove host
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </>
            }
          />
        ))
      )}
      {/* A missing CLI is the one state where adding a host helps with nothing:
          there is no binary to sign in with, and the remedy below says so. */}
      {state === "missing" ? null : (
        <SettingsField
          label="Add a host"
          sub={addHost.sub}
          control={
            <button
              // Genuinely unavailable, not in-flight: until the list has loaded
              // the dialog cannot tell a new host from one already present, and
              // an add that lands on an existing host rewrites its product —
              // routing that instance at the wrong CLI.
              disabled={props.loading}
              className="settings-button"
              type="button"
              onClick={props.onAdd}
            >
              {addHost.button}
            </button>
          }
          help="You name the instance. Nothing is inferred from a hostname, and no ssh remote ever appears here on its own."
        />
      )}
      {state === "unknown" || status === undefined ? null : (
        <SettingsField
          label={blocks(state) ? "What to do" : `What ${label} can report`}
          control={
            <span className="settings-field__help">
              {blocks(state) ? remedy(status, state) : capabilities(status)}
            </span>
          }
        />
      )}
    </SettingsSection>
  );
}

/** The per-host sign-in command. Exported because the row RENDERS it and the
 *  pane's Copy button puts it on the clipboard — two places that must never
 *  print different commands. */
export function signInCommand(row: ForgeHostRow): string {
  return `${row.cli} auth login --hostname ${row.host}`;
}

/**
 * The row's own sub-line. The product is the section's to say, so this only
 * carries what differs between two hosts of the same product.
 *
 * "added by you" is NOT conditional on the account being absent, which was a
 * bug on the way here: `kindSource` flips nothing when a CLI later signs in to
 * a hand-added host, so hiding the note behind "no account" would take away the
 * only thing on the row explaining why it, alone, can be removed.
 */
function describeRow(row: ForgeHostRow): string {
  const parts: string[] = [];
  if (row.account !== undefined) parts.push(`signed in as ${row.account}`);
  if (row.kindSource === "config") parts.push("added by you");
  if (parts.length === 0) {
    parts.push(
      row.origin === "config" ? "no account here yet" : `reported by ${row.cli}`
    );
  }
  return parts.join(" · ");
}

/**
 * Says WHY the switch reads as it does, so a derived default never looks like
 * a choice somebody made.
 *
 * The "off" sentence names the one thing off does NOT stop — the CLI sign-in
 * check that discovered the host in the first place. Claiming a clean "runs no
 * command" is the same lie as an "off" that still shells out, and this is the
 * only line the user reads before deciding whether the switch means anything.
 */
function sourceNote(row: ForgeHostRow): string {
  if (row.enabledSource === "env") {
    return "Set by an environment variable; the switch cannot change it.";
  }
  if (row.enabledSource === "config") {
    return row.enabled
      ? "On because you turned it on."
      : "Off. PwrGit reads nothing from this host and mints no token for it, clones and forks included. Only the sign-in check that lists it here still runs.";
  }
  // `auto` means nobody has decided — a known forge is on by default. It does
  // NOT mean "on because a CLI is signed in": permission deliberately does not
  // depend on enumeration having succeeded.
  const scopes =
    row.scopes === undefined ? "" : ` · scopes: ${row.scopes.join(", ")}`;
  return `On by default${scopes}`;
}

/**
 * The section's one-line summary — and the only thing visible when it is
 * folded, which is why it carries the host tally rather than leaving it to a
 * chip that has a state to report instead.
 */
function describeProduct(
  kind: ForgeKind,
  status: ForgeStatus | undefined,
  rows: readonly ForgeHostRow[],
  state: ForgeProductState
): ReactNode {
  const noun = `${changeRequestNoun(kind)}s`;
  const { label, cli } = forgeProduct(kind);
  if (state === "unknown") {
    return (
      <>
        {label} {noun}, read through <code>{cli}</code>.
      </>
    );
  }
  // A missing CLI reports no hosts at all — and saying "no host is signed in"
  // beside a "Not installed" chip blames the login for a missing binary, which
  // the remedy correctly does not.
  if (state === "missing") {
    return (
      <>
        {label} {noun} need the <code>{cli}</code> CLI.
      </>
    );
  }
  if (state === "off") return `Every ${label} host is switched off.`;

  const readable = readableHosts(status);
  const tally = hostTally(rows);
  if (readable.length > 0) {
    return (
      <>
        Reading {noun} from {hostsPhrase(readable)} through <code>{cli}</code>.
        {tally}
      </>
    );
  }
  if (state === "connected") {
    // Connected through the CLI's own default host, which has no row here and
    // so is not named. Claiming "no host is signed in" beside a "Connected"
    // chip would be the two halves of this header contradicting each other.
    return (
      <>
        Reading {noun} through the <code>{cli}</code> CLI’s default host.
      </>
    );
  }
  return `No host is signed in to read ${noun} from.${tally}`;
}

/** Only said when it is not already obvious from the rows — with every host on,
 *  the switches say it better than a count does. */
function hostTally(rows: readonly ForgeHostRow[]): string {
  const on = rows.filter((row) => row.enabled).length;
  if (rows.length === 0 || on === rows.length) return "";
  return ` ${on} of ${rows.length} hosts on.`;
}

/** Name a few hosts, then count the rest — a header is a sentence, and `gh` can
 *  be signed in to a dozen Enterprise instances. Mirrors the cap
 *  `ownersPhrase` applies to the fork dialog's owner list. */
function hostsPhrase(hosts: string[]): string {
  if (hosts.length <= 3) return hosts.join(", ");
  return `${hosts.slice(0, 3).join(", ")} and ${hosts.length - 3} more`;
}

/** Enabled hosts that answered with a credential — what "Connected" is made of,
 *  and the only hosts this section may claim anything about. */
function readableHosts(status: ForgeStatus | undefined): string[] {
  return (status?.hosts ?? [])
    .filter((host) => host.enabled && host.loggedIn)
    .map((host) => host.host);
}

/** Hosts the user could sign in to: allowed by the switch, no credential yet. */
function awaitingSignIn(status: ForgeStatus): string[] {
  return status.hosts
    .filter((host) => host.enabled && !host.loggedIn)
    .map((host) => host.host);
}

/** The body a product with no rows of its own still owes the reader. */
function emptyNote(kind: ForgeKind, state: ForgeProductState): ReactNode {
  const { label, cli } = forgeProduct(kind);
  if (state === "missing") {
    return (
      <>
        The <code>{cli}</code> CLI is not installed, so no {label} host can be
        listed.
      </>
    );
  }
  if (state === "connected") {
    return (
      <>
        <code>{cli}</code> is signed in to its own default host, which has no
        switch of its own.
      </>
    );
  }
  return (
    <>
      <code>{cli}</code> is not signed in to a {label} host. Sign in from a
      terminal, then re-check — or add the instance below.
    </>
  );
}

/** Whether this product can be read at all. A blocked one owes the user a
 *  remedy; a working one lists what it is able to report. */
function blocks(state: ForgeProductState): boolean {
  return state === "missing" || state === "off" || state === "signedOut";
}

/**
 * A blocked product gets the exact thing that unblocks it — install the CLI,
 * sign in, or turn a host back on. Only called when `blocks` says so.
 */
function remedy(status: ForgeStatus, state: ForgeProductState): ReactNode {
  const label = forgeProduct(status.kind).label;
  const noun = changeRequestNoun(status.kind);
  if (state === "missing") {
    return (
      <>
        Install the {label} CLI (<code>{status.cli}</code>) to see status here.
      </>
    );
  }
  if (state === "off") {
    // Says what is actually true: no host is read and no token is minted. The
    // earlier wording claimed no `${cli}` command runs at all, while the probe
    // spawns `--version` on every pass to learn the CLI is there — which is how
    // this section knows to say "Off" rather than "Not installed".
    return `Turn a host on above to read ${noun} status. PwrGit reads no host and mints no token while every host is off.`;
  }
  return (
    <>
      Run <code>{signInCommandFor(status)}</code> in a terminal, then this
      updates on its own.
    </>
  );
}

/** What the integration is able to report, so a missing feature reads as a
 *  known limit of that provider rather than a bug. */
function capabilities(status: ForgeStatus): string {
  const keys = Object.keys(CAPABILITY_LABELS) as (keyof ForgeCapabilities)[];
  const supported = keys.filter((key) => status.capabilities[key]);
  const missing = keys.filter((key) => !status.capabilities[key]);
  const supportedText = supported
    .map((key) => CAPABILITY_LABELS[key])
    .join(" · ");
  const missingText =
    missing.length === 0
      ? ""
      : `Not supported by this forge: ${missing
          .map((key) => CAPABILITY_LABELS[key].toLowerCase())
          .join(", ")}.`;
  // Either half may be empty; joining only the present ones keeps a stray
  // leading ". " out of the hint.
  return [supportedText, missingText].filter((part) => part !== "").join(". ");
}

/**
 * The sign-in command for a signed-out product.
 *
 * The bare command authenticates the forge's SaaS host, so it is only right
 * when that host is one of the ones waiting. Otherwise it names a host
 * explicitly — `glab auth login` would send someone to gitlab.com when the
 * instance they are missing is a self-managed one, or when an env allowlist has
 * switched gitlab.com off entirely. With several waiting, the first is named:
 * any of them moves the state, and the rows above own the full per-host list.
 */
function signInCommandFor(status: ForgeStatus): string {
  const waiting = awaitingSignIn(status);
  if (waiting.length === 0 || waiting.includes(forgeProduct(status.kind).saasHost)) {
    return `${status.cli} auth login`;
  }
  return `${status.cli} auth login --hostname ${waiting[0]}`;
}
