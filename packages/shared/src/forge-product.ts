import {
  FORGE_KINDS,
  isForgeKind,
  type ForgeCapabilities,
  type ForgeHost,
  type ForgeKind
} from "./types";

/**
 * Everything PwrGit knows about a hosting product that is not code.
 *
 * One table per product rather than one table per question. The per-product
 * facts used to be seven tables and twenty-nine per-product ternaries spread
 * across main and the renderer, and the two shapes fail differently: a
 * `Record<ForgeKind, …>` missing a member is a type error that names itself,
 * while a ternary silently answers a third product as GitHub. Adding a product
 * is a `FORGE_KINDS` member plus one entry here; `tsc` then lists whatever else
 * is genuinely behavioural.
 *
 * It lives in `packages/shared` because both processes read it —
 * `renderer-does-not-import-main` blocks main's tables, and a renderer-local
 * copy is exactly how the CLI name ended up with two spellings.
 */
export type ForgeProduct = {
  /** The product's name, as the user sees it written. */
  readonly label: string;
  /**
   * The binary PwrGit speaks through.
   *
   * Reaches the user as a command they are told to run, so a second copy that
   * drifted would print a command naming a CLI the app never invokes.
   */
  readonly cli: string;
  readonly installHint?: string;
  readonly signInHost: { readonly flag: string; readonly apiPath?: string };
  /**
   * The hosted instance.
   *
   * The ONE host resolution recognises without enumeration — a hostname is
   * evidence of nothing else, so every self-managed instance must be
   * enumerated or added by hand. It is also the fallback the status probe uses
   * when no CLI reports an account, and the one host whose sign-in command
   * needs no `--hostname`.
   */
  readonly saasHost: string;
  /** What this product calls a change request, capitalized as a UI noun. */
  readonly changeRequestLabel: string;
  /** The product's own reference sigil — `owner/repo#4` vs `owner/repo!4`. */
  readonly changeRequestSigil: string;
  /** What this product calls a non-personal account. Calling a GitLab group
   *  an "organization" is wrong in the one screen where the user is choosing
   *  between them. */
  readonly organizationNoun: string;
  /**
   * How many `/`-separated segments a project path may have.
   *
   * GitHub is exactly `owner/repo`; anything deeper is a tree, a gist or a page
   * URL that merely looks like a repository. GitLab nests groups arbitrarily,
   * so `pwrdrvr/qa/forge/PwrGit-Test` is one project. Two is always the
   * minimum — a project has an owner and a name on every product.
   *
   * A finite ceiling, not `Infinity`: `JSON.stringify(Infinity)` is `null` and
   * `n <= null` is false, so one round trip through JSON — a diagnostics dump,
   * a cached snapshot — would silently reject every path on an unbounded
   * product rather than accept every path.
   */
  readonly maxPathSegments: number;
  /**
   * Env allowlist naming the hosts of this product PwrGit may talk to.
   *
   * Read only by main, and here anyway: it is a per-product string, and the
   * point of this table is that a new product is one entry rather than one
   * entry plus a handful of tables elsewhere that each fail loudly on their own.
   */
  readonly hostAllowlistEnv: string;
  /**
   * Wording for adding one of this product's hosts by hand.
   *
   * There is a button per product because the product is *chosen* there, never
   * derived: enumeration carries it for free, but a hostname is not evidence,
   * so a single "Add host…" button would have to guess or ask afterwards.
   */
  readonly addHost: {
    /** Button label in the product's section of Settings → Forges. */
    readonly button: string;
    /**
     * The helper line under that button.
     *
     * Per-product because the self-hosted thing has a different NAME on each
     * one — GitHub calls it Enterprise, GitLab calls it self-managed — and a
     * shared "for an instance you have not signed in to yet" is the wording
     * that made the button look like it might add anything at all.
     */
    readonly sub: string;
    /** The dialog's title, which is what settles the product. */
    readonly title: string;
    /** An example hostname, shown in the field. */
    readonly placeholder: string;
  };
  /**
   * Creating a fork returns before the fork is usable.
   *
   * Only a message depends on this today — cancelling the checkout after the
   * remote exists says so — but it is a property of the product's API, not of
   * the screen that reports it.
   */
  readonly forkCompletesAsynchronously: boolean;
  /**
   * What the integration can answer at all.
   *
   * Not a login: these say what is possible, which is why a false one means
   * "never ask" rather than "ask and handle the failure". Static per product,
   * so they need no network call, and they ride on `ForgeStatus` to the
   * settings pane and the dialogs.
   */
  readonly capabilities: ForgeCapabilities;
};

/**
 * Frozen, not merely `Readonly<>`.
 *
 * `Readonly<Record<…>>` constrains the top level only: every field below it,
 * and every field of `capabilities`, stays writable at runtime. This object is
 * now process-global in both bundles and its `capabilities` ride on
 * `ForgeStatus` to the settings pane, so one stray write — a test poking a
 * capability, a helper "patching" a product — would leak into every later
 * caller in that process.
 */
export const FORGE_PRODUCTS: Readonly<Record<ForgeKind, ForgeProduct>> = freeze({
  gitcafe: {
    label: "GitCafe",
    cli: "cafe",
    installHint: "Install Bun, then run `bun i -g @gitcafe/cli` to install or update cafe (0.5.0 or newer). Both bun and cafe must be available.",
    signInHost: { flag: "--host", apiPath: "/api" },
    saasHost: "git.cafe",
    changeRequestLabel: "Pull request",
    changeRequestSigil: "#",
    organizationNoun: "organization",
    maxPathSegments: 2,
    hostAllowlistEnv: "PWRGIT_GITCAFE_HOSTS",
    addHost: { button: "Add GitCafe host…", title: "Add a GitCafe host", placeholder: "git.cafe" },
    forkCompletesAsynchronously: true,
    capabilities: {
      batchedBranchLookup: false,
      batchedCommitAssociation: false,
      changeSizeAndTimeline: false,
      commitAuthorIdentity: false,
      forkDefaultBranchOnly: false
    }
  },
  github: {
    label: "GitHub",
    cli: "gh",
    signInHost: { flag: "--hostname" },
    saasHost: "github.com",
    changeRequestLabel: "Pull request",
    changeRequestSigil: "#",
    organizationNoun: "organization",
    maxPathSegments: 2,
    hostAllowlistEnv: "PWRGIT_GITHUB_HOSTS",
    addHost: {
      button: "Add GitHub Enterprise…",
      sub: "For an Enterprise instance you have not signed in to yet.",
      title: "Add a GitHub Enterprise host",
      placeholder: "github.acme-inc.com"
    },
    forkCompletesAsynchronously: false,
    capabilities: {
      batchedBranchLookup: true,
      // `associatedPullRequests` takes many commit OIDs in one aliased query.
      batchedCommitAssociation: true,
      changeSizeAndTimeline: true,
      commitAuthorIdentity: true,
      forkDefaultBranchOnly: true
    }
  },
  gitlab: {
    label: "GitLab",
    cli: "glab",
    signInHost: { flag: "--hostname" },
    saasHost: "gitlab.com",
    changeRequestLabel: "Merge request",
    changeRequestSigil: "!",
    organizationNoun: "group",
    maxPathSegments: Number.MAX_SAFE_INTEGER,
    hostAllowlistEnv: "PWRGIT_GITLAB_HOSTS",
    addHost: {
      button: "Add GitLab instance…",
      sub: "For a self-managed instance you have not signed in to yet.",
      title: "Add a GitLab instance",
      placeholder: "gitlab.example.com"
    },
    // The fork API returns before the project is ready to clone.
    forkCompletesAsynchronously: true,
    capabilities: {
      // `mergeRequests(sourceBranches: [...])` batches natively.
      batchedBranchLookup: true,
      // GitLab has no batch commit-association endpoint: it is one REST call
      // per SHA, which is why callers must cap the visible set rather than fan
      // out.
      batchedCommitAssociation: false,
      changeSizeAndTimeline: true,
      commitAuthorIdentity: true,
      // GitLab's fork API takes no branch filter; offering the switch would be
      // offering a control that does nothing.
      forkDefaultBranchOnly: false
    }
  }
});

function freeze(
  products: Record<ForgeKind, ForgeProduct>
): Readonly<Record<ForgeKind, ForgeProduct>> {
  for (const product of Object.values(products)) {
    Object.freeze(product.capabilities);
    Object.freeze(product.addHost);
    Object.freeze(product.signInHost);
    Object.freeze(product);
  }
  return Object.freeze(products);
}

/**
 * The product PwrGit assumes when a host is `other`.
 *
 * A behaviour this registry preserved rather than chose. Eight per-product
 * ternaries answered `other` as GitHub — a clone hint, a default hostname, an
 * error sentence — and unpicking each is a separate question about what those
 * surfaces should say for a host no provider claims. One named constant so a
 * third product cannot change what `other` means by accident, and so the
 * assumption is greppable when somebody does take that question on.
 */
export const ASSUMED_FORGE_KIND: ForgeKind = "github";

/** The product for a kind. */
export function forgeProduct(kind: ForgeKind): ForgeProduct {
  return FORGE_PRODUCTS[kind];
}

/**
 * The product for a host, or null when no product claims it.
 *
 * Guarded with `isForgeKind` rather than indexed after an `=== "other"` test,
 * because a bare index answers three ways, not two: a registry entry, or
 * `undefined` for a string no product claims — which is NOT the declared
 * `null`, so a caller's `!== null` check passes and the next property access
 * throws — or, for a key like `constructor` or `__proto__` (both legal
 * lowercase intranet labels), a truthy member inherited from `Object.prototype`
 * that defeats `forgeProductOrAssumed`'s `??` entirely. `classifyForgeHost`
 * guards the same class of input for the same reason.
 *
 * Values reach here from SQLite rows, settings.json and IPC payloads, none of
 * which the type annotation actually constrains.
 */
export function forgeProductFor(host: ForgeHost | undefined): ForgeProduct | null {
  return isForgeKind(host) ? FORGE_PRODUCTS[host] : null;
}

/** The product for a host, resolving `other` — and anything unrecognized —
 *  through `ASSUMED_FORGE_KIND`. */
export function forgeProductOrAssumed(host: ForgeHost | undefined): ForgeProduct {
  return forgeProductFor(host) ?? FORGE_PRODUCTS[ASSUMED_FORGE_KIND];
}

/**
 * The product's name — "GitHub", "GitLab".
 *
 * Takes a `ForgeKind`, not a `ForgeHost`: the tables this replaced were keyed
 * by kind, so passing `other` was a compile error at every call site. A caller
 * that really does hold an unclassified host asks `forgeProductOrAssumed`
 * itself, which keeps the assumption at the site that makes it.
 */
export function forgeLabel(kind: ForgeKind): string {
  return FORGE_PRODUCTS[kind].label;
}

/** The hosted instance of a host's product. */
export function forgeSaasHost(host: ForgeHost): string {
  return forgeProductOrAssumed(host).saasHost;
}

/**
 * The product's own word for a change request, as a UI noun: "Pull request",
 * "Merge request". Each forge's own vocabulary, so a card matches the site the
 * row came from.
 */
export function changeRequestLabel(kind: ForgeKind): string {
  return FORGE_PRODUCTS[kind].changeRequestLabel;
}

/** The same word lowercased, for use inside a sentence. */
export function changeRequestNoun(kind: ForgeKind): string {
  return changeRequestLabel(kind).toLowerCase();
}

/** The product's reference sigil — `owner/repo#4` against `owner/repo!4`. */
export function changeRequestSigil(kind: ForgeKind): string {
  return FORGE_PRODUCTS[kind].changeRequestSigil;
}

/** What a product can answer at all. */
export function forgeCapabilities(kind: ForgeKind): ForgeCapabilities {
  return FORGE_PRODUCTS[kind].capabilities;
}

/**
 * Which product a CLI name belongs to, or null for a name no product claims.
 *
 * The clone box accepts a pasted `gh repo clone …` / `glab repo clone …`, where
 * the CLI is more specific than the dialog's current host toggle. Derived so
 * that a third product's CLI is recognised there without anybody remembering
 * to widen a regex.
 */
export function forgeKindForCli(cli: string): ForgeKind | null {
  const normalized = cli.trim().toLowerCase();
  // Both sides normalized: the regex that produced `cli` carries the `i` flag,
  // so matching a table value verbatim would answer null for a command the
  // box had already accepted, and the paste would resolve against whichever
  // product the host toggle happened to be on.
  return (
    FORGE_KINDS.find(
      (kind) => FORGE_PRODUCTS[kind].cli.trim().toLowerCase() === normalized
    ) ?? null
  );
}

/** Every product's CLI, in `FORGE_KINDS` order. */
export function forgeCliNames(): string[] {
  return FORGE_KINDS.map((kind) => FORGE_PRODUCTS[kind].cli);
}

/**
 * Whether a project path of this depth can exist on this product.
 *
 * Two is the floor everywhere — an owner and a name. The ceiling is the
 * product's, and getting it wrong in either direction is silent: too low drops
 * a real GitLab subgroup project, too high reads a GitHub tree URL as a
 * repository and clones a URL that cannot exist.
 */
export function forgeAllowsPathDepth(kind: ForgeKind, segments: number): boolean {
  // `forgeProductFor`, not a bare index: this is reached from remote parsing
  // with a kind that came off an override map, and a product nothing claims
  // must answer "no path fits" — the module's own null no-op — rather than
  // throwing out of a resolver whose callers treat it as total.
  const product = forgeProductFor(kind);
  return product !== null && segments >= 2 && segments <= product.maxPathSegments;
}

/** Copyable CLI sign-in syntax, shared by both settings sections. */
export function forgeSignInCommand(kind: ForgeKind, hostname?: string): string {
  const product = forgeProduct(kind);
  const base = `${product.cli} auth login`;
  if (hostname === undefined) return base;
  const value = product.signInHost.apiPath === undefined
    ? hostname
    : `https://${hostname}${product.signInHost.apiPath}`;
  return `${base} ${product.signInHost.flag} ${value}`;
}
