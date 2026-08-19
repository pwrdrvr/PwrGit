import type {
  CloneRepository,
  ForgeOwner,
  ForgeStatus,
  ForkPreflight,
  ForkProgress
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
  statuses: ForgeStatus[],
  source: CloneRepository | null
): ForgeOwner[] {
  const host = source?.host ?? "github";
  const status = statuses.find((candidate) => candidate.host === host);
  if (status === undefined) return [];
  return status.owners.filter(
    (owner) =>
      source === null ||
      owner.login.toLowerCase() !== source.owner.toLowerCase()
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
  if (host === "gitlab") {
    return {
      label: "GitLab CLI",
      detail: (nameWithOwner) => `glab repo clone ${nameWithOwner}`
    };
  }
  return {
    label: "GitHub CLI",
    detail: (nameWithOwner) => `gh repo clone ${nameWithOwner}`
  };
}

/** The status entry for one forge, or a "not installed" stand-in so callers
 *  never have to branch on undefined. */
export function statusFor(
  statuses: ForgeStatus[],
  host: CloneRepository["host"]
): ForgeStatus {
  return (
    statuses.find((status) => status.host === host) ?? {
      host,
      installed: false,
      loggedIn: false,
      owners: []
    }
  );
}

/** What the source list should say when it has no rows to show.
 *
 *  `null` catalog means the owner listings are still in flight — which is the
 *  state the dialog spends its first seconds in, and reporting it as "install
 *  the CLI" tells the user to fix something that is not broken. */
export function sourceEmptyMessage(input: {
  catalogLoaded: boolean;
  catalogError: string | null;
  status: ForgeStatus;
  cliLabel: string;
  query: string;
}): string | null {
  if (input.catalogError !== null) return input.catalogError;
  if (!input.catalogLoaded) return "Loading repositories…";
  if (!input.status.installed) return `Install the ${input.cliLabel} to search.`;
  if (!input.status.loggedIn) return `Sign in with the ${input.cliLabel} to search.`;
  return `No repositories match \u201C${input.query}\u201D.`;
}
