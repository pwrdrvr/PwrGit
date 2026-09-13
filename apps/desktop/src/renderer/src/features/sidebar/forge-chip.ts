import {
  isForgeKind,
  parseForgeRemote,
  resolveForgeHostDisplays,
  type ForgeHost,
  type ForgeHostDisplay,
  type ForgeHostMap,
  type ForgeKind,
  type RepoIdentity
} from "@pwrgit/shared";

/**
 * What a forge chip draws, and what it says when you rest on it.
 *
 * Two clones of one project — one from GitHub, one from a GitLab mirror —
 * are two sidebar rows reading `PwrGit`, and nothing else on either row tells
 * them apart. The chip is the shortest thing that can, which is usually one
 * glyph and no words at all.
 *
 * `title` always carries the full hostname the mark replaced, so the chip is
 * an abbreviation rather than a loss (SC 1.4.4's intent, the same reason the
 * repo name beside it carries one).
 */
export type ForgeChipView = {
  /** The product's mark to draw, or null for a host no product claims — then
   *  `name` is the whole chip. */
  kind: ForgeKind | null;
  /**
   * Text beside the mark, or null when the mark says it alone.
   *
   * The only part that may be truncated on screen — the full hostname is in
   * `title`.
   */
  name: string | null;
  /**
   * How many OTHER forge hosts this repository also has remotes on.
   *
   * Kept apart from `name` rather than baked into one string so the chip can
   * ellipsise the name and keep the count: `+1` at the end of a truncated
   * string is the first thing to disappear, and it is the part that says the
   * name is not the whole answer. It also has to survive a chip whose name is
   * null, where there is no string to append it to at all.
   */
  others: number;
  title: string;
};

/** Hosts with no settings row still need naming — env-allowlisted ones are
 *  exactly that case. Named alone, so nothing else in the set is consulted. */
function displayFor(
  hostname: string,
  displays: ReadonlyMap<string, ForgeHostDisplay>,
  identity: RepoIdentity
): ForgeHostDisplay {
  const known = displays.get(hostname);
  if (known !== undefined) return known;
  // `host` is only right for origin's own hostname; a second remote's product
  // is not known here, and `other` makes the naming derive from the hostname
  // alone rather than claim a product for it.
  const host = hostname === identity.hostname ? identity.host : "other";
  return resolveOne(hostname, host);
}

/** One host, resolved against a set containing only itself — which is what
 *  "named alone" means, and is total: the resolver always answers for every
 *  hostname it is handed. */
function resolveOne(hostname: string, host: ForgeHost): ForgeHostDisplay {
  const display = resolveForgeHostDisplays([{ hostname, host }]).get(hostname);
  /* c8 ignore next -- unreachable: the resolver answers for every input */
  if (display === undefined) throw new Error(`unresolved forge host ${hostname}`);
  return display;
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
  displays: ReadonlyMap<string, ForgeHostDisplay>
): ForgeChipView | null {
  if (identity === undefined) return null;
  const display = displayFor(identity.hostname, displays, identity);
  // Absent `remoteHostnames` is "not known", NOT "no other remotes" — a row
  // stored before the column existed has never been asked. Both render the
  // same bare chip; only a known, non-empty set of OTHER hosts adds a count.
  const others = (identity.remoteHostnames ?? []).filter(
    (hostname) => hostname !== identity.hostname
  );
  if (others.length === 0) {
    return {
      kind: display.kind,
      name: display.name,
      others: 0,
      title: `origin is on ${identity.hostname}`
    };
  }
  // The tooltip always spells the other hosts out, never their marks: it is
  // the one place the chip's abbreviation is cashed back in.
  const alsoNames = others.map(
    (hostname) => displayFor(hostname, displays, identity).fullName
  );
  return {
    kind: display.kind,
    name: display.name,
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
  displays: ReadonlyMap<string, ForgeHostDisplay>
): ForgeChipView | null {
  const parsed = parseForgeRemote(url, overrides);
  if (parsed === null || !isForgeKind(parsed.host)) return null;
  const display =
    displays.get(parsed.hostname) ?? resolveOne(parsed.hostname, parsed.host);
  return {
    kind: display.kind,
    name: display.name,
    others: 0,
    title: `On ${parsed.hostname}`
  };
}
