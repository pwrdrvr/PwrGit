import {
  forgeCloneUrls,
  forgeRemoteUrlLike,
  isForgeKind,
  parseForgeRemote,
  type ForgeHostMap,
  type ForkCheckoutPreflight,
  type RepoIdentity
} from "@pwrgit/shared";

/**
 * Forking a repository that is already checked out.
 *
 * The dialog this drives is the fork dialog with both pickers gone: the source
 * is whatever `origin` points at and there is no destination, because nothing
 * is cloned. What it gains instead is a statement of the remote layout it is
 * about to write — the part a user has to agree to, since it changes where
 * their next push lands.
 */

/** What the submit button does and says. Derived from the preflight rather
 *  than tracked, for the same reason `forkAction` is: a button whose label and
 *  action can disagree is the bug worth designing out. */
export type ForkCheckoutAction =
  | { kind: "fork"; label: string }
  | { kind: "adopt"; label: string }
  | { kind: "blocked"; label: string; message: string };

const FORK_LABEL = "Fork & switch origin";

export function forkCheckoutAction(
  preflight: ForkCheckoutPreflight | null
): ForkCheckoutAction {
  if (preflight === null) return { kind: "fork", label: FORK_LABEL };
  if (preflight.fork.blocked !== undefined) {
    return {
      kind: "blocked",
      label: FORK_LABEL,
      message: preflight.fork.blocked.message
    };
  }
  // An existing fork is not an obstacle here, unlike in the clone flow where it
  // decides between cloning and revealing. The forge hands the same repository
  // back and the rewire is identical — only the sentence changes, because
  // "Fork" would promise to create something that is already there.
  return preflight.fork.existing === undefined
    ? { kind: "fork", label: FORK_LABEL }
    : { kind: "adopt", label: "Switch origin to my fork" };
}

/** One line of the "what this changes" list. */
export type RemoteChange = {
  /** The remote's name, as it will read in `git remote -v`. */
  remote: string;
  nameWithOwner: string;
  url: string;
  /** What this remote is for, in the user's terms. */
  note: string;
  /** True when the remote already exists and points there — nothing is
   *  written for it. Drawn differently so the list is a statement of the
   *  outcome, not a claim about what was done. */
  unchanged: boolean;
};

/**
 * The remote layout the rewire will produce, exactly as the user will find it.
 *
 * `origin` first because it is the one that changes meaning: it is what `git
 * push` uses and what every local branch already tracks. Both URLs are built
 * in `origin`'s current protocol — see `remoteProtocol` in main for why that
 * is read rather than asked.
 */
export function remoteChanges(input: {
  preflight: ForkCheckoutPreflight;
  /** `owner/name` of the fork, as the dialog currently has it. */
  target: string;
  /** The chosen upstream, or null when the user declined one. */
  upstream: string | null;
}): RemoteChange[] {
  const { preflight } = input;
  const hostname = preflight.fork.source.hostname;
  // Shaped after the remote being replaced, exactly as `forkRemoteUrl` in main
  // does it — otherwise the list promises a URL the rewire is not going to
  // write, and on a forge reached at a non-default SSH port that difference is
  // the difference between a remote that works and one that does not.
  const url = (nameWithOwner: string): string => {
    const shaped = forgeRemoteUrlLike(preflight.origin.url, nameWithOwner);
    if (shaped !== null) return shaped;
    const urls = forgeCloneUrls(hostname, nameWithOwner);
    return preflight.protocol === "ssh" ? urls.sshUrl : urls.httpsUrl;
  };
  const changes: RemoteChange[] = [
    {
      remote: "origin",
      nameWithOwner: input.target,
      url: url(input.target),
      note: "your fork — where pushes go",
      unchanged: false
    }
  ];
  if (input.upstream !== null) {
    changes.push({
      remote: preflight.upstreamRemote.name,
      nameWithOwner: input.upstream,
      url: url(input.upstream),
      note: preflight.upstreamRemote.existing
        ? "already points there — left alone"
        : "the original — fetch and rebase on it",
      unchanged: preflight.upstreamRemote.existing
    });
  }
  return changes;
}

/**
 * Whether the preflight on screen still describes the remote the dialog is
 * about to name.
 *
 * `upstreamRemote` is answered about one repository, and the choice is open
 * whenever the source is itself a fork. Printing a name that was answered
 * about a different repository would describe a remote the rewire is not going
 * to make, so the list waits for the preflight to catch up rather than
 * guessing.
 */
export function upstreamAnswerIsCurrent(
  preflight: ForkCheckoutPreflight | null,
  upstream: string | null
): boolean {
  if (preflight === null) return false;
  if (upstream === null) return true;
  return (
    preflight.upstreamFor.toLowerCase() === upstream.toLowerCase()
  );
}

/** The sentence above the list. It names the repository being left behind,
 *  because that is the fact a user checks before agreeing. */
export function forkCheckoutLead(preflight: ForkCheckoutPreflight): string {
  return preflight.fork.source.viewerCanPush === false
    ? `You can't push to ${preflight.origin.nameWithOwner}. Fork it and this checkout keeps working — against your own copy.`
    : `Fork ${preflight.origin.nameWithOwner} and point this checkout at your own copy.`;
}

/**
 * Whether the `origin` row under REMOTES offers to fork, and how loudly.
 *
 * It used to offer only once the forge had said "you can't push". That left
 * the one remote row that is about forking showing nothing but Fetch in two
 * common cases: a checkout whose identity nobody had read yet, and one you
 * can push to but want a copy of elsewhere. The verb belongs wherever
 * `origin` is on a forge. What the forge said only decides whether the button
 * is urgent (`cannot_push`, the accent colour) or merely available.
 *
 * Silent in two cases. One is an `origin` no product claims (a NAS remote
 * parses fine and is not a forge). The other is an `origin` that already IS
 * your fork. Forking your own fork is not a next step anyone looks for there,
 * and the repo menu still offers it for the rare case.
 */
export function originForkOffer(
  fetchUrl: string,
  identity: Pick<RepoIdentity, "viewerCanPush" | "parent" | "nameWithOwner"> | undefined,
  hosts: ForgeHostMap
): { nameWithOwner: string; urgent: boolean } | null {
  const parsed = parseForgeRemote(fetchUrl, hosts);
  if (parsed === null || !isForgeKind(parsed.host)) return null;
  if (identity?.viewerCanPush === true && identity.parent !== undefined) {
    return null;
  }
  return {
    nameWithOwner: identity?.nameWithOwner ?? parsed.nameWithOwner,
    urgent: identity?.viewerCanPush === false
  };
}
