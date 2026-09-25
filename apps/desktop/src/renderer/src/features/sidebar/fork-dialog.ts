import {
  forgeAllHostsOff,
  forgeBlockAt,
  forgeCanAnswerSaas,
  forgeProductOrAssumed,
  forgeSaasBlock,
  isForgeKind,
  parseForgeRemote,
  type CloneRepository,
  type ForgeHost,
  type ForgeHostMap,
  type ForgeOwner,
  type ForgeStatus,
  type ForkPreflight,
  type ForkProgress,
  type RemoteEndpoint,
  type Repo
} from "@pwrgit/shared";

export const FORK_PROGRESS_LABELS: Record<ForkProgress["phase"], string> = {
  starting: "Preparing fork",
  creating: "Creating the fork",
  awaiting_fork: "Waiting for the forge to prepare it",
  counting: "Counting objects",
  compressing: "Compressing objects",
  receiving: "Receiving objects",
  resolving: "Resolving deltas",
  checking_out: "Checking out files",
  adding_upstream: "Adding the upstream remote",
  repointing_origin: "Pointing origin at your fork",
  indexing: "Adding repository to PwrGit"
};

/** What the submit button should do and say. Derived rather than tracked as
 *  state: the three outcomes depend only on the preflight, and a button whose
 *  label and action can disagree is exactly the bug worth designing out. */
export type ForkAction =
  | { kind: "fork"; label: string }
  | { kind: "clone_existing"; label: string }
  | { kind: "reveal_existing"; label: string; path: string }
  | { kind: "blocked"; label: string; message: string };

export function forkAction(preflight: ForkPreflight | null): ForkAction {
  if (preflight === null) return { kind: "fork", label: "Fork & clone" };
  if (preflight.blocked !== undefined) {
    return {
      kind: "blocked",
      label: "Fork & clone",
      message: preflight.blocked.message
    };
  }
  const existing = preflight.existing;
  if (existing === undefined) return { kind: "fork", label: "Fork & clone" };
  const path = existing.localPaths[0];
  if (path !== undefined) {
    return { kind: "reveal_existing", label: "Reveal checkout", path };
  }
  return { kind: "clone_existing", label: "Clone your fork" };
}

/** Accounts a fork can be created in, for the forge the source lives on. The
 *  source's own owner is dropped: neither forge will fork a repository into
 *  the account that owns it, so offering it is offering a guaranteed error. */
export function forkTargets(
  owners: ForgeOwner[],
  source: CloneRepository | null,
  // The forge picker's current value, used until a source pins the host. It
  // was defaulted to GitHub, so switching the picker to GitLab with nothing
  // selected still listed GitHub organizations.
  activeHost: ForgeHost = "github"
): ForgeOwner[] {
  const host = source?.host ?? activeHost;
  return owners.filter(
    (owner) =>
      owner.host === host &&
      (source === null ||
        owner.login.toLowerCase() !== source.owner.toLowerCase())
  );
}

/** Prefer the personal account — the overwhelmingly common fork target — and
 *  otherwise the first org the forge listed. */
export function defaultForkTarget(targets: ForgeOwner[]): ForgeOwner | null {
  return targets.find((owner) => owner.kind === "user") ?? targets[0] ?? null;
}

/** A fork name is a single path segment: it is appended to a namespace, and
 *  it also becomes the checkout folder's name. */
export function isValidForkName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(name);
}

export function forkNameProblem(
  name: string,
  preflight: ForkPreflight | null
): string | null {
  if (name.trim() === "") return "Give the fork a name.";
  if (!isValidForkName(name)) {
    return "Use letters, numbers, dots, dashes and underscores.";
  }
  if (preflight?.blocked?.code === "forking_disabled") {
    return preflight.blocked.message;
  }
  return null;
}

/** Whether the dialog should ask which repository `upstream` points at. One
 *  choice is not a question — it is only genuinely open when the source is
 *  itself a fork. */
export function needsUpstreamChoice(preflight: ForkPreflight | null): boolean {
  return (preflight?.upstreamChoices.length ?? 0) > 1;
}

export function defaultUpstream(preflight: ForkPreflight | null): string | null {
  return preflight?.upstreamChoices[0]?.nameWithOwner ?? null;
}

/** The forge CLI label for the `cli` clone protocol, which is host-dependent
 *  now that it is not always `gh`. */
export function cliProtocolLabel(host: CloneRepository["host"]): {
  label: string;
  detail: (nameWithOwner: string) => string;
} {
  const product = forgeProductOrAssumed(host);
  return {
    label: `${product.label} CLI`,
    detail: (nameWithOwner) => `${product.cli} repo clone ${nameWithOwner}`
  };
}

/** The status entry for one forge, or undefined when main has not reported
 *  it. Deliberately not a fabricated stand-in: `ForgeStatus` now carries the
 *  forge's capabilities, and inventing those would let the UI claim a forge
 *  can do something nobody asked. */
export function statusFor(
  statuses: ForgeStatus[],
  host: ForgeHost
): ForgeStatus | undefined {
  return statuses.find((status) => status.kind === host);
}

/**
 * Whether a forge can answer either dialog for one INSTANCE.
 *
 * It used to ask only about the SaaS host, because both dialogs reached their
 * provider by kind alone and that is the instance a kind-only lookup gets.
 * They now carry a hostname end to end, so asking the SaaS question greyed out
 * the CLI protocol for a machine signed in only to a company host — refusing
 * the operation main had just learned to do. Omit `hostname` only where the
 * instance genuinely is the SaaS one.
 *
 * One helper so the host toggle, the protocol list and the empty message
 * cannot disagree about it.
 */
export function forgeCanAnswerDialog(
  status: ForgeStatus | undefined,
  hostname?: string
): boolean {
  if (hostname === undefined) return forgeCanAnswerSaas(status);
  return status !== undefined && forgeBlockAt(status, hostname) === null;
}

/**
 * Whether a forge is worth offering in the host toggle at all.
 *
 * A different question from the one above: the toggle picks a FORGE, and an
 * Enterprise-only sign-in makes GitHub perfectly usable while github.com
 * itself is unauthenticated. Asking the SaaS question here removed the only
 * forge such a user has.
 */
export function forgeCanAnswerAnywhere(status: ForgeStatus | undefined): boolean {
  return (
    status !== undefined &&
    status.installed &&
    status.loggedIn &&
    !forgeAllHostsOff(status)
  );
}

/** Whether the fork dialog should offer the default-branch-only switch. Read
 *  from the forge's reported capability rather than hardcoding a host, so a
 *  forge that gains the ability needs no change here. */
export function supportsDefaultBranchOnly(
  status: ForgeStatus | undefined
): boolean {
  return status?.capabilities.forkDefaultBranchOnly === true;
}

/** The owners a search will be scoped to, named for the prompt, and shortened
 *  once the list is longer than a sentence wants to be. */
export function ownersPhrase(owners: string[]): string {
  if (owners.length === 0) return "";
  if (owners.length <= 3) return owners.join(", ");
  return `${owners.slice(0, 3).join(", ")} and ${owners.length - 3} more`;
}

/** What the source list should say when it has no rows to show.
 *
 *  Ordered by what the user can act on. Availability comes first because it is
 *  the only state a person must fix elsewhere; an unloaded catalog is next
 *  because reporting that moment as "install the CLI" tells someone to fix
 *  something that is not broken. An empty box is not a failed search — nothing
 *  has been asked yet, so it prompts rather than reporting no matches, and a
 *  search in flight says so rather than leaving the previous "no matches"
 *  standing for the length of the round trip. */
export function sourceEmptyMessage(input: {
  catalogLoaded: boolean;
  catalogError: string | null;
  status: ForgeStatus | undefined;
  cliLabel: string;
  query: string;
  searching: boolean;
  searchError: string | null;
  /** Accounts the search is scoped to, so the prompt can name them. */
  owners: string[];
}): string | null {
  if (input.catalogError !== null) return input.catalogError;
  if (!input.catalogLoaded) return "Checking which forges are signed in…";
  // The SaaS instance specifically: that is the provider this search runs
  // against, and a self-managed sign-in does not make it answerable.
  const block = forgeSaasBlock(input.status);
  if (block === "cli_missing") return `Install the ${input.cliLabel} to search.`;
  if (block === "host_off") {
    // They are signed in; they switched the host off. "Sign in" would name a
    // remedy that cannot change this.
    return `Turn this host on in Settings → Forges to search.`;
  }
  if (block === "signed_out") {
    return `Sign in with the ${input.cliLabel} to search.`;
  }
  if (input.query.trim() === "") {
    return input.owners.length === 0
      ? "Type a name to search, or paste owner/name."
      : `Type to search ${ownersPhrase(input.owners)}, or paste any owner/name.`;
  }
  if (input.searching) return "Searching…";
  if (input.searchError !== null) return input.searchError;
  return `No repositories match “${input.query}”.`;
}

/** What to call a fork target under the row. The two forges use different
 *  nouns for the same thing, and calling a GitLab group an "organization" is
 *  wrong in the one place the user is choosing between them. */
export function ownerKindLabel(owner: ForgeOwner): string {
  if (owner.kind === "user") return "personal account";
  // `OrAssumed`, matching `cliProtocolLabel` above: `ForgeOwner.host` is typed
  // `ForgeKind` but the object is built in main and structured-cloned here, so
  // a strict lookup would throw inside the owner-list render — unmounting the
  // picker — where the ternary this replaced degraded to "organization".
  return forgeProductOrAssumed(owner.host).organizationNoun;
}

/** The catalog rows that belong to the forge currently being browsed.
 *
 *  The catalog is a single list spanning every signed-in forge, so without
 *  this the GitLab tab lists GitHub repositories — which cannot be forked
 *  into a GitLab group, and whose chips say so while the picker says
 *  otherwise. */
export function repositoriesOnHost(
  repositories: CloneRepository[],
  host: ForgeHost
): CloneRepository[] {
  return repositories.filter((repository) => repository.host === host);
}

/**
 * The repository the fork dialog should open on, built from a row already in
 * the sidebar.
 *
 * Pressing a button labelled "Fork…" with a repository selected and being
 * asked to type its name is the gap this closes. The identity is what PwrGit
 * already knows about `origin`, so the seed carries the real visibility,
 * lineage and push access rather than the `unknown` placeholder a pasted slug
 * gets — the preflight still upgrades it, but the row reads correctly in the
 * meantime, read-only chip included.
 *
 * Null when there is nothing to seed with: no repository selected, or one
 * whose identity has never been read (absent is "not looked up", and inventing
 * a hostname from a name would point the dialog at the wrong instance).
 * `sshUrl` / `httpsUrl` are blank for the same reason — the dialog never
 * clones the SOURCE, and a fabricated URL is a URL something could follow.
 */
export function forkSeedFromRepo(repo: Repo | undefined): CloneRepository | null {
  const identity = repo?.identity;
  if (identity === undefined) return null;
  return {
    name: identity.name,
    owner: identity.owner,
    nameWithOwner: identity.nameWithOwner,
    visibility: identity.visibility,
    host: identity.host,
    hostname: identity.hostname,
    sshUrl: "",
    httpsUrl: "",
    localPaths: [],
    ...(identity.viewerCanPush === undefined
      ? {}
      : { viewerCanPush: identity.viewerCanPush }),
    ...(identity.parent === undefined ? {} : { parent: identity.parent }),
    ...(identity.root === undefined ? {} : { root: identity.root })
  };
}

/**
 * The same seed, read off `origin`'s URL, for a repository whose identity has
 * not been read yet.
 *
 * `forkSeedFromRepo` refuses without an identity, and so the dialog opened on
 * an empty search for a checkout added since the window mounted. The slug is
 * a local fact all the same. `origin` names its host and path, so what is
 * missing is only what the forge says ABOUT the repository, and the dialog's
 * preflight asks for exactly that as soon as it opens. The seed therefore says
 * `unknown` rather than guessing a visibility or a push answer.
 *
 * The FETCH url, like `readRemotes` in main: a push url pointed elsewhere is a
 * mirror, and forking the mirror forks the wrong project. Null for a host no
 * product claims. A NAS remote parses perfectly well and is not a forge, and a
 * fork aimed at it would be aimed at whatever SaaS host shares the path.
 */
export function forkSeedFromOrigin(
  remotes: readonly RemoteEndpoint[],
  hosts: ForgeHostMap
): CloneRepository | null {
  const origin = remotes.find((remote) => remote.name === "origin");
  if (origin === undefined) return null;
  const parsed = parseForgeRemote(origin.fetchUrl, hosts);
  if (parsed === null || !isForgeKind(parsed.host)) return null;
  return {
    name: parsed.repo,
    owner: parsed.owner,
    nameWithOwner: parsed.nameWithOwner,
    visibility: "unknown",
    host: parsed.host,
    hostname: parsed.hostname,
    sshUrl: "",
    httpsUrl: "",
    localPaths: []
  };
}
