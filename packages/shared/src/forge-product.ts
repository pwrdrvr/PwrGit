import {
  FORGE_KINDS,
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
  /** The product's key. Equals the `FORGE_PRODUCTS` key it is stored under. */
  kind: ForgeKind;
  /** The product's name, as the user sees it written. */
  label: string;
  /**
   * The binary PwrGit speaks through.
   *
   * Reaches the user as a command they are told to run, so a second copy that
   * drifted would print a command naming a CLI the app never invokes.
   */
  cli: string;
  /**
   * The hosted instance.
   *
   * The ONE host resolution recognises without enumeration — a hostname is
   * evidence of nothing else, so every self-managed instance must be
   * enumerated or added by hand. It is also the fallback the status probe uses
   * when no CLI reports an account, and the one host whose sign-in command
   * needs no `--hostname`.
   */
  saasHost: string;
  /** What this product calls a change request, capitalized as a UI noun. */
  changeRequestLabel: string;
  /** The product's own reference sigil — `owner/repo#4` vs `owner/repo!4`. */
  changeRequestSigil: string;
  /** What this product calls a non-personal account. Calling a GitLab group
   *  an "organization" is wrong in the one screen where the user is choosing
   *  between them. */
  organizationNoun: string;
  /**
   * How many `/`-separated segments a project path may have.
   *
   * GitHub is exactly `owner/repo`; anything deeper is a tree, a gist or a page
   * URL that merely looks like a repository. GitLab nests groups arbitrarily,
   * so `pwrdrvr/qa/forge/PwrGit-Test` is one project. Two is always the
   * minimum — a project has an owner and a name on every product.
   */
  maxPathSegments: number;
  /**
   * Env allowlist naming the hosts of this product PwrGit may talk to.
   *
   * Read only by main, and here anyway: it is a per-product string, and the
   * point of this table is that a new product is one entry rather than one
   * entry plus a handful of tables elsewhere that each fail loudly on their own.
   */
  hostAllowlistEnv: string;
  /**
   * Wording for adding one of this product's hosts by hand.
   *
   * There is a button per product because the product is *chosen* there, never
   * derived: enumeration carries it for free, but a hostname is not evidence,
   * so a single "Add host…" button would have to guess or ask afterwards.
   */
  addHost: {
    /** Button label in Settings → Forges → Hosts. */
    button: string;
    /** The dialog's title, which is what settles the product. */
    title: string;
    /** An example hostname, shown in the field. */
    placeholder: string;
  };
  /**
   * Creating a fork returns before the fork is usable.
   *
   * Only a message depends on this today — cancelling the checkout after the
   * remote exists says so — but it is a property of the product's API, not of
   * the screen that reports it.
   */
  forkCompletesAsynchronously: boolean;
  /**
   * What the integration can answer at all.
   *
   * Not a login: these say what is possible, which is why a false one means
   * "never ask" rather than "ask and handle the failure". Static per product,
   * so they need no network call, and they ride on `ForgeStatus` to the
   * settings pane and the dialogs.
   */
  capabilities: ForgeCapabilities;
};

export const FORGE_PRODUCTS: Readonly<Record<ForgeKind, ForgeProduct>> = {
  github: {
    kind: "github",
    label: "GitHub",
    cli: "gh",
    saasHost: "github.com",
    changeRequestLabel: "Pull request",
    changeRequestSigil: "#",
    organizationNoun: "organization",
    maxPathSegments: 2,
    hostAllowlistEnv: "PWRGIT_GITHUB_HOSTS",
    addHost: {
      button: "Add GitHub Enterprise…",
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
    kind: "gitlab",
    label: "GitLab",
    cli: "glab",
    saasHost: "gitlab.com",
    changeRequestLabel: "Merge request",
    changeRequestSigil: "!",
    organizationNoun: "group",
    maxPathSegments: Number.POSITIVE_INFINITY,
    hostAllowlistEnv: "PWRGIT_GITLAB_HOSTS",
    addHost: {
      button: "Add GitLab instance…",
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
};

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

/** The product for a host, or null when no provider claims it. Callers with
 *  nothing sensible to say about `other` use this and say nothing. */
export function forgeProductFor(host: ForgeHost): ForgeProduct | null {
  return host === "other" ? null : FORGE_PRODUCTS[host];
}

/** The product for a host, resolving `other` through `ASSUMED_FORGE_KIND`. */
export function forgeProductOrAssumed(host: ForgeHost): ForgeProduct {
  return forgeProductFor(host) ?? FORGE_PRODUCTS[ASSUMED_FORGE_KIND];
}

/** The product's name — "GitHub", "GitLab" — for a host. */
export function forgeLabel(host: ForgeHost): string {
  return forgeProductOrAssumed(host).label;
}

/** The binary a host is spoken to through. */
export function forgeCli(host: ForgeHost): string {
  return forgeProductOrAssumed(host).cli;
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
export function changeRequestLabel(host: ForgeHost): string {
  return forgeProductOrAssumed(host).changeRequestLabel;
}

/** The same word lowercased, for use inside a sentence. */
export function changeRequestNoun(host: ForgeHost): string {
  return changeRequestLabel(host).toLowerCase();
}

/** The product's reference sigil — `owner/repo#4` against `owner/repo!4`. */
export function changeRequestSigil(host: ForgeHost): string {
  return forgeProductOrAssumed(host).changeRequestSigil;
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
  return (
    FORGE_KINDS.find((kind) => FORGE_PRODUCTS[kind].cli === normalized) ?? null
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
  return segments >= 2 && segments <= FORGE_PRODUCTS[kind].maxPathSegments;
}
