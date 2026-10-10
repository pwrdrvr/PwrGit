import {
  forgeCloneUrls,
  forgeProductFor,
  forgeProductOrAssumed,
  type CloneRepository,
  type ForgeOwner,
  type ForkPreflight
} from "@pwrgit/shared";

/**
 * The Clone dialog's "Clone from" choice: clone the repository that was
 * picked, or clone your fork of it — creating the fork first when the forge
 * says there is none.
 *
 * Drawn in `design/Fork While Cloning - UX Review.dc.html`, turns 2a and 3.
 * The forge question is `repo:forkPreflight`, the same one the Fork… dialog
 * asks; what is new here is only how the answer turns into a default and a
 * pill, which is why it lives in these pure helpers and not in the JSX.
 */
export type CloneFrom = "original" | "fork";

/** What the fork card says about the fork, from what the forge answered. */
export type ForkCardState =
  | { kind: "checking" }
  | { kind: "create" }
  | { kind: "exists" }
  | { kind: "checked_out"; path: string }
  | { kind: "unavailable"; message: string };

export function forkCardState(input: {
  preflight: ForkPreflight | null;
  checkError: string | null;
  /** Accounts the fork could land in, or null while they load. */
  targets: ForgeOwner[] | null;
  cliLabel: string;
}): ForkCardState {
  if (input.checkError !== null) {
    return { kind: "unavailable", message: input.checkError };
  }
  // Nowhere to put it is a fact about the signed-in user, known before the
  // forge has said anything about this repository.
  if (input.targets !== null && input.targets.length === 0) {
    return {
      kind: "unavailable",
      message: `Sign in with the ${input.cliLabel} to fork from here.`
    };
  }
  const preflight = input.preflight;
  if (preflight === null) return { kind: "checking" };
  if (preflight.blocked !== undefined) {
    return { kind: "unavailable", message: preflight.blocked.message };
  }
  const existing = preflight.existing;
  if (existing === undefined) return { kind: "create" };
  const path = existing.localPaths[0];
  return path === undefined ? { kind: "exists" } : { kind: "checked_out", path };
}

/**
 * Whether Clone offers the pair at all.
 *
 * Not for a local path (there is no forge to fork on), not for a host no
 * product claims, and not for a repository the signed-in account owns —
 * forking your own repository into your own account is something no forge
 * will do, and offering it into one of your orgs from a Clone dialog is a
 * question nobody asked. Waits for the accounts, so the pair is drawn once
 * and does not appear and then vanish under the pointer.
 */
export function offersCloneFrom(input: {
  source: CloneRepository | null;
  owners: ForgeOwner[] | null;
  preflight: ForkPreflight | null;
}): boolean {
  const { source, owners } = input;
  if (source === null || source.localPath !== undefined) return false;
  if (source.host === "other" || owners === null || forgeProductFor(source.host)?.capabilities.repositoryApi === false) return false;
  const owner = source.owner.toLowerCase();
  if (owners.some((o) => o.kind === "user" && o.login.toLowerCase() === owner)) {
    return false;
  }
  const code = input.preflight?.blocked?.code;
  return code !== "self_owned" && code !== "unsupported_host";
}

/**
 * Whether the signed-in account may push to the original. Preflight's answer
 * first: it read the repository just now, where a search row may carry no
 * permissions at all. Absent stays absent — see `CloneRepository.viewerCanPush`.
 */
export function canPushOriginal(
  source: CloneRepository,
  preflight: ForkPreflight | null
): boolean | undefined {
  return preflight?.source.viewerCanPush ?? source.viewerCanPush;
}

/**
 * Which card is chosen until the user chooses.
 *
 * The original, unless the forge said you cannot push there AND your fork of
 * it already exists — then cloning the fork is the obvious next step, and
 * cloning something you will be refused a push to is the trap. Creating a
 * repository on the user's account is never a default: a read-only repository
 * is cloned to be read at least as often as to be changed.
 */
export function cloneFromDefault(
  canPush: boolean | undefined,
  card: ForkCardState
): CloneFrom {
  return canPush === false &&
    (card.kind === "exists" || card.kind === "checked_out")
    ? "fork"
    : "original";
}

/**
 * The repository the new checkout's `origin` will be, when it is the fork.
 *
 * An existing fork is the forge's own answer and carries real URLs. One that
 * does not exist yet is built from the preflight's target, on the source's
 * instance — a fork lands where its source lives — so the protocol cards and
 * the "Will create" line describe the checkout that will actually be made.
 */
export function forkOriginRepository(preflight: ForkPreflight): CloneRepository {
  if (preflight.existing !== undefined) return preflight.existing;
  const { source, target } = preflight;
  return {
    name: target.name,
    owner: target.owner,
    nameWithOwner: target.nameWithOwner,
    visibility: source.visibility,
    host: source.host,
    hostname: source.hostname,
    ...forgeCloneUrls(source.hostname, target.nameWithOwner),
    localPaths: []
  };
}

/** The pill on the fork card, and its tone. Tones are `.clone-chip`
 *  modifiers: dashed for an absence, accent for a fact about your fork. */
export function forkCardPill(
  card: ForkCardState,
  host: CloneRepository["host"]
): { label: string; tone: "unknown" | "accent" | "muted" } {
  switch (card.kind) {
    case "checking":
      return { label: "checking…", tone: "unknown" };
    case "create":
      return { label: "will be created", tone: "unknown" };
    case "exists":
      return { label: `on ${forgeProductOrAssumed(host).label}`, tone: "accent" };
    case "checked_out":
      return { label: "checked out", tone: "accent" };
    case "unavailable":
      return { label: "unavailable", tone: "muted" };
  }
}

/** The sentence under the fork card's slug. */
export function forkCardDetail(
  card: ForkCardState,
  host: CloneRepository["host"],
  upstream: string | null
): string {
  const kept =
    upstream === null ? "The original is kept" : `${upstream} is kept`;
  switch (card.kind) {
    case "checking":
      return "Looking for a fork you already have…";
    case "create":
      return `Created on ${forgeProductOrAssumed(host).label} first. ${kept} as upstream.`;
    case "exists":
      return `Already yours. ${kept} as upstream.`;
    case "checked_out":
      return `Already checked out at ${card.path}`;
    case "unavailable":
      return card.message;
  }
}

/** The sentence under the original's slug. */
export function originalCardDetail(canPush: boolean | undefined): string {
  if (canPush === false) return "You can read it. Pushes will be refused.";
  if (canPush === true) return "You can push here.";
  return "Clone it as it is.";
}
