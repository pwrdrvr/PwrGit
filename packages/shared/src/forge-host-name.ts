import { FORGE_PRODUCTS, forgeProductFor } from "./forge-product";
import { FORGE_KINDS, isForgeKind, type ForgeHost, type ForgeKind } from "./types";

/**
 * The short name a forge host goes by on screen.
 *
 * Two checkouts of the same project — one from GitHub, one from a GitLab
 * mirror — land in the sidebar as two rows reading `PwrGit`, and nothing on
 * either row says which is which. A chip naming the host settles it, but only
 * if the chip is short: `github.acme.huge-corp.southeast.us.corp` in a 320px
 * row is worse than no chip at all.
 *
 * So a host has a name, and the name has two sources, in this order:
 *
 * 1. **What the user called it.** `ForgeHostConfig.label`, typed in
 *    Settings → Forges → Hosts. Always wins, and is never second-guessed.
 * 2. **A name derived from the hostname**, for the overwhelming majority of
 *    hosts nobody will ever bother naming.
 *
 * The derivation reads hostname LABELS, which is not the rule
 * `forge/AGENTS.md` forbids. "A hostname is never evidence" is about which
 * product runs at a host — which CLI is spawned, which API is called, whose
 * token is minted. Nothing here answers that question or feeds anything that
 * does: this module is handed the already-resolved `ForgeHost` and only
 * decides which characters to print. A wrong answer here is an ugly chip, and
 * the user can overrule it by typing four letters.
 */

/** Longest short name worth having. Past this a chip stops being a chip — the
 *  sidebar is 320px and the name shares the row with the repo's own. Counted
 *  in code points, so an emoji costs one. */
export const FORGE_HOST_LABEL_MAX = 24;

/**
 * Hostname labels that name no particular instance.
 *
 * `gitlab.example.com` and `git.example.com` are both "example" to a human,
 * and a chip reading `gitlab` beside another reading `git` distinguishes
 * nothing. Each product contributes its own name and CLI, so a third product
 * widens this list by existing rather than by somebody remembering to.
 *
 * Display only — see this file's header. Nothing routes on it.
 */
const GENERIC_LABELS: readonly string[] = [
  "git",
  "ghe",
  "scm",
  "source",
  "code",
  "vcs",
  "forge",
  "repo",
  "repos",
  "www"
];

function genericLabels(): ReadonlySet<string> {
  const words = new Set(GENERIC_LABELS);
  for (const kind of FORGE_KINDS) {
    words.add(FORGE_PRODUCTS[kind].label.toLowerCase());
    words.add(FORGE_PRODUCTS[kind].cli.toLowerCase());
  }
  return words;
}

/**
 * Trim a user-typed short name to something a chip can hold, or null when what
 * is left says nothing.
 *
 * Null is the signal to CLEAR the stored label and fall back to the derived
 * name — which is why the empty string has to reach here rather than being
 * filtered out by the caller. Control and format characters are replaced
 * rather than dropped: this string is rendered into a row and a `title`, and a
 * bidi override smuggled into it would reorder the text around it.
 */
export function sanitizeForgeHostLabel(raw: string): string | null {
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return null;
  // Spread, not `slice`: `slice` counts UTF-16 units and can cut a surrogate
  // pair in half, leaving a lone surrogate that renders as a replacement
  // character and no longer round-trips through JSON cleanly.
  const points = [...cleaned];
  if (points.length <= FORGE_HOST_LABEL_MAX) return cleaned;
  const trimmed = points.slice(0, FORGE_HOST_LABEL_MAX).join("").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The name a host goes by when nobody has named it.
 *
 * A product's own hosted instance is the product — `github.com` is "GitHub",
 * and writing out the hostname there would be noise on the one host everybody
 * recognizes. Anything else is named after the first hostname label that is
 * not a generic hosting word, which is where a company's name almost always
 * sits: `ghe.acme.example` and `github.acme.huge-corp.southeast.us.corp` are
 * both "acme".
 *
 * Never the LAST label, which is a TLD — `acme.com` is "acme", not "com" —
 * unless that is the only label there is.
 */
export function derivedForgeHostName(hostname: string, host: ForgeHost): string {
  const product = forgeProductFor(host);
  if (product !== null && hostname === product.saasHost) return product.label;
  const labels = hostname.split(".").filter((label) => label !== "");
  if (labels.length === 0) return hostname;
  const candidates = labels.length > 1 ? labels.slice(0, -1) : labels;
  const generic = genericLabels();
  return (
    candidates.find((label) => !generic.has(label)) ??
    candidates[0] ??
    hostname
  );
}

/** One host, as far as naming is concerned. */
export type ForgeHostNaming = {
  /** Canonical lowercase hostname, as `canonicalForgeHostname` produces it. */
  hostname: string;
  host: ForgeHost;
  /** What the user called it, unsanitized — this is settings.json, and nothing
   *  validates that file. */
  label?: string;
};

/** The name for one host, with no idea what other hosts are called. Use
 *  `resolveForgeHostNames` wherever several are on screen together. */
export function forgeHostName(entry: ForgeHostNaming): string {
  const chosen =
    entry.label === undefined ? null : sanitizeForgeHostLabel(entry.label);
  return chosen ?? derivedForgeHostName(entry.hostname, entry.host);
}

/**
 * How one host should be drawn: a mark, a name, or both.
 *
 * The mark is the short form — a chip that is one glyph costs a repo row almost
 * nothing, which is the whole reason the chip can be on every row. The name
 * appears only when the mark cannot carry the answer by itself.
 */
export type ForgeHostDisplay = {
  /** The product whose mark identifies this host, or null when no product
   *  claims it — then there is no mark and `name` is all there is. */
  kind: ForgeKind | null;
  /** Text to draw beside the mark, or null when the mark says it alone. */
  name: string | null;
  /** The name in full, whether or not it is drawn. Tooltips and the settings
   *  placeholder want it even when the chip is a bare glyph. */
  fullName: string;
};

/**
 * Decide the mark-and-name for every host in one set.
 *
 * A mark alone answers "which forge" only while this product has ONE host
 * here: with `github.com` and `ghe.acme.example` both switched on, two
 * identical marks are two rows that still cannot be told apart — the same
 * failure `resolveForgeHostNames` guards against for derived names, one level
 * up. Those hosts get their names back.
 *
 * A name the USER typed is always drawn. Typing one is a request to see that
 * word; replacing it with a glyph reads as the field not having worked.
 */
export function resolveForgeHostDisplays(
  hosts: readonly ForgeHostNaming[]
): Map<string, ForgeHostDisplay> {
  const names = resolveForgeHostNames(hosts);
  const hostsPerKind = new Map<ForgeKind, number>();
  const seen = new Set<string>();
  for (const entry of hosts) {
    if (seen.has(entry.hostname)) continue;
    seen.add(entry.hostname);
    if (isForgeKind(entry.host)) {
      hostsPerKind.set(entry.host, (hostsPerKind.get(entry.host) ?? 0) + 1);
    }
  }
  const out = new Map<string, ForgeHostDisplay>();
  for (const entry of hosts) {
    if (out.has(entry.hostname)) continue;
    const fullName = names.get(entry.hostname) ?? entry.hostname;
    const kind = isForgeKind(entry.host) ? entry.host : null;
    const named =
      entry.label !== undefined && sanitizeForgeHostLabel(entry.label) !== null;
    const markSpeaksAlone =
      kind !== null && !named && (hostsPerKind.get(kind) ?? 0) <= 1;
    out.set(entry.hostname, {
      kind,
      name: markSpeaksAlone ? null : fullName,
      fullName
    });
  }
  return out;
}

/**
 * Name every host in one set, so no two derived names collide.
 *
 * The whole point of the chip is to tell two rows apart, and the derivation
 * above is lossy enough to defeat that on its own: `github.acme.example` and
 * `gitlab.acme.example` both derive to "acme", which is a chip that answers
 * the question with the wrong answer twice. A derived name that lands on more
 * than one hostname is abandoned for the full hostname on all of them — long,
 * but true, and the user can shorten it by naming them.
 *
 * A name the USER chose is never withdrawn, even when it collides. They typed
 * it while looking at the list; that is their call to make, and silently
 * replacing it with a hostname would read as the field not working.
 *
 * Keyed by hostname. A hostname listed twice is named once.
 */
export function resolveForgeHostNames(
  hosts: readonly ForgeHostNaming[]
): Map<string, string> {
  const chosen = new Map<string, string>();
  const derived = new Map<string, string>();
  for (const entry of hosts) {
    if (chosen.has(entry.hostname) || derived.has(entry.hostname)) continue;
    const label =
      entry.label === undefined ? null : sanitizeForgeHostLabel(entry.label);
    if (label === null) {
      derived.set(entry.hostname, derivedForgeHostName(entry.hostname, entry.host));
    } else {
      chosen.set(entry.hostname, label);
    }
  }
  const uses = new Map<string, number>();
  for (const name of derived.values()) {
    const key = name.toLowerCase();
    uses.set(key, (uses.get(key) ?? 0) + 1);
  }
  const out = new Map(chosen);
  for (const [hostname, name] of derived) {
    out.set(
      hostname,
      (uses.get(name.toLowerCase()) ?? 0) > 1 ? hostname : name
    );
  }
  return out;
}
