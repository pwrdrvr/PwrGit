import {
  forgeHostName,
  isForgeKind,
  parseForgeRemote,
  type ForgeHostMap,
  type RepoIdentity
} from "@pwrgit/shared";

/**
 * What a forge chip draws, and what it says when you rest on it.
 *
 * Two clones of one project — one from GitHub, one from a GitLab mirror —
 * are two sidebar rows reading `PwrGit`, and nothing else on either row tells
 * them apart. The chip is the shortest thing that can.
 *
 * `title` always carries the full hostname the short name replaced, so the
 * chip is an abbreviation rather than a loss (SC 1.4.4's intent, the same
 * reason the repo name beside it carries one).
 */
export type ForgeChipView = {
  /** The host's short name. The only part that may be truncated on screen —
   *  the full hostname is in `title`. */
  name: string;
  /**
   * How many OTHER forge hosts this repository also has remotes on.
   *
   * Kept apart from `name` rather than baked into one string so the chip can
   * ellipsise the name and keep the count: `+1` at the end of a truncated
   * string is the first thing to disappear, and it is the part that says the
   * name is not the whole answer.
   */
  others: number;
  title: string;
};

/** The chip as one string — what it reads as, for tests and titles. */
export function forgeChipText(chip: ForgeChipView): string {
  return chip.others === 0 ? chip.name : `${chip.name} +${chip.others}`;
}

/** A hostname's short name, falling back to naming it alone when it has no
 *  settings row — env-allowlisted hosts are exactly that case. */
function nameFor(
  hostname: string,
  names: ReadonlyMap<string, string>,
  identity: RepoIdentity
): string {
  return (
    names.get(hostname) ??
    forgeHostName({
      hostname,
      // `host` is only right for origin's own hostname; a second remote's
      // product is not known here, and `other` makes `forgeHostName` derive
      // from the hostname alone rather than claim a product for it.
      host: hostname === identity.hostname ? identity.host : "other"
    })
  );
}

/**
 * The chip for one repository row.
 *
 * It names `origin` — what you push to, which is what every other identity
 * mark on the row already describes. When the repo has remotes on other
 * forges too, the chip says `+n` rather than going quiet: a row with a second
 * forge is the one most in need of telling apart, and blanking it there would
 * withhold the answer in exactly that case. The count and the tooltip are what
 * keep `origin`'s name from reading as the whole truth.
 *
 * Null when there is nothing to say: no identity read yet, so no host to name.
 */
export function repoForgeChip(
  identity: RepoIdentity | undefined,
  names: ReadonlyMap<string, string>
): ForgeChipView | null {
  if (identity === undefined) return null;
  const base = nameFor(identity.hostname, names, identity);
  // Absent `remoteHostnames` is "not known", NOT "no other remotes" — a row
  // stored before the column existed has never been asked. Both render the
  // same bare chip; only a known, non-empty set of OTHER hosts adds a count.
  const others = (identity.remoteHostnames ?? []).filter(
    (hostname) => hostname !== identity.hostname
  );
  if (others.length === 0) {
    return {
      name: base,
      others: 0,
      title: `origin is on ${identity.hostname}`
    };
  }
  const alsoNames = others.map((hostname) => nameFor(hostname, names, identity));
  return {
    name: base,
    others: others.length,
    title: `origin is on ${identity.hostname}; also ${alsoNames.join(", ")}`
  };
}

/**
 * The chip for one remote row in the remotes disclosure.
 *
 * This is where a repository with remotes on two forges is told plainly,
 * remote by remote — the repo row above can only carry a count.
 *
 * Null for a remote no product claims. A git remote is never evidence of a
 * forge (see `main/forge/AGENTS.md`): a bare repo on a NAS parses as a remote
 * perfectly well, and badging it would invent a forge for it.
 */
export function remoteForgeChip(
  url: string,
  overrides: ForgeHostMap,
  names: ReadonlyMap<string, string>
): ForgeChipView | null {
  const parsed = parseForgeRemote(url, overrides);
  if (parsed === null || !isForgeKind(parsed.host)) return null;
  const name =
    names.get(parsed.hostname) ??
    forgeHostName({ hostname: parsed.hostname, host: parsed.host });
  return { name, others: 0, title: `On ${parsed.hostname}` };
}
