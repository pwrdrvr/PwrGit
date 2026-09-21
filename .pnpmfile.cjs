// Project-level pnpm install hooks. Loaded automatically by pnpm
// every time it resolves dependencies (`pnpm install`, `pnpm add`,
// `pnpm install --frozen-lockfile` in CI). The companion `.npmrc`
// sets `global-pnpmfile=` so contributors with a user-level
// `global-pnpmfile` configured don't accidentally double-apply hooks
// and break `--frozen-lockfile` via pnpmfileChecksum drift — every
// machine that runs pnpm in this repo (yours, mine, CI) hashes
// exactly this file and nothing else.
//
// ── Why this file exists ────────────────────────────────────────────
//
// Refuse to install dependencies specified via git URLs (git@, git+,
// ssh://git@, GitHub/GitLab/Bitbucket HTTP, `user/repo`-style
// shortcuts, etc.). Two reasons:
//
//   1. Supply-chain integrity. Git specs aren't pinned to a tarball
//      hash the way npm specs are — the lockfile records a commit
//      SHA, but the act of installing runs the package's lifecycle
//      scripts (`prepare`, `prepack`, `install`, etc.) against
//      arbitrary code fetched from arbitrary git remotes. There's no
//      registry-side integrity check.
//
//   2. Reproducibility. A git spec can resolve differently across
//      time (force-pushed tags, deleted commits, registry outages).
//      Tarball specs with integrity hashes either match or don't.
//
// The codebase has no git deps today. This hook locks that in — a
// malicious or careless PR that adds one will fail `pnpm install`
// with a loud error before anything is fetched or any lifecycle
// script runs.
//
// Adapted from the user-level pattern many of us already run as
// `~/.pnpm/global_pnpmfile.cjs`; moved into the repo so the
// protection is a project guarantee, reviewable in PRs, active in CI
// without depending on per-contributor machine setup.

"use strict";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];

// Match the spec shapes pnpm itself recognizes as git fetches. The
// last alternation (`user/repo#ref?`) is the GitHub shortcut form npm
// supports — pnpm treats it the same as `github:user/repo`.
//
// The scp-style (`user@host:path`) and `ssh://` alternations match any
// username, not just `git`. pnpm hands both to `resolveGit` whoever
// the user is, and resolution runs `git ls-remote` against the remote
// BEFORE the fetcher hook below can refuse anything — so a spec this
// pattern misses has already contacted an arbitrary host. `git@` and
// `ssh://git@` alone let `alice@github.com:user/repo.git` through.
//
// That last alternation excludes `:` from its first character class
// for a reason: without it, any protocol spec whose path is a single
// segment parses as a `user/repo` shortcut and is blocked. Reading
// `file:../local` as `file:..` + `/` + `local` is the case that bit
// us; `link:../local` and `workspace:../pkg` fail the same way. Specs
// with two or more path segments (`file:./packages/x`) only escape by
// accident, because the trailing class cannot match a second `/`.
const GIT_SPEC_PATTERN =
  /^(?:git(?:\+|:)|[^/\s@]+@[^/\s@:]+:|ssh:\/\/|github:|gitlab:|bitbucket:|https?:\/\/(?:www\.)?(?:github|gitlab|bitbucket)\.com\/|[^/@\s:]+\/[^/\s]+(?:#.*)?$)/;

function isGitSpec(spec) {
  return typeof spec === "string" && GIT_SPEC_PATTERN.test(spec);
}

function readPackage(pkg) {
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!isGitSpec(spec)) continue;
      // Transitive packages' `devDependencies` are never installed by
      // pnpm — they only matter when the package is being developed
      // on, not when it's pulled in as a dep. The original intent of
      // this hook was to block git specs that would actually run
      // lifecycle scripts, which is the install-time risk; transitive
      // devDeps are stripped silently so we don't false-positive on
      // upstream maintainers' tooling choices (e.g. yauzl →
      // buffer-crc32@0.2.3 has an ancient `tap` devDep tree that
      // bottoms out in github:iansu/eslint-plugin-node-core).
      //
      // The root workspace's devDependencies are still scanned: pnpm
      // calls readPackage on every package, including our own, so a
      // git devDep in apps/desktop/package.json or any sibling still
      // throws below.
      if (field === "devDependencies" && !isWorkspaceRootPackage(pkg)) {
        delete deps[name];
        continue;
      }
      throw blockedGitSpecError(name, spec, field, pkg.name);
    }
  }

  // `pnpm.overrides` — and `resolutions`, the yarn-compatible alias
  // pnpm folds into the same mechanism — are not dependency fields,
  // but pnpm resolves their values exactly like specs. Without this,
  // a git spec parked in an override slipped past the manifest scan
  // and was caught only by the fetcher below, whose error names
  // neither the package nor where it was declared.
  //
  // That is the quietest injection point in the manifest: an override
  // repoints a TRANSITIVE package, so it lands in nobody's
  // `dependencies` block and a reviewer skimming the diff for a git
  // URL in the usual place will not see it.
  //
  // Gated on first-party manifests. pnpm only honours overrides from
  // the workspace root, so a registry package's own copy is inert and
  // flagging it would be a false positive with nothing behind it. This
  // gate is slightly wider than the root — it also covers @pwrgit/*
  // packages, where an override is dead config pnpm ignores; a git URL
  // sitting in one is still worth failing on rather than leaving to
  // rot.
  //
  // NOT covered: specs declared in a pnpm-workspace.yaml `catalog:` /
  // `catalogs:` block. readPackage only ever sees manifests, and the
  // importer's spec is the literal string `catalog:` — the git URL
  // lives in a file this hook never reads, so closing that would mean
  // parsing YAML here with no dependencies available. The fetcher
  // below still refuses the fetch, so a catalog entry is a worse error
  // message, not a bypass.
  if (isWorkspaceRootPackage(pkg)) {
    scanOverrides(pkg.pnpm && pkg.pnpm.overrides, "pnpm.overrides", pkg.name);
    scanOverrides(pkg.resolutions, "resolutions", pkg.name);
  }

  return pkg;
}

// Override maps have no devDependencies-style carve-out: every value
// here is a spec pnpm will resolve, so any git shape is a hard stop.
function scanOverrides(overrides, label, owner) {
  if (!overrides || typeof overrides !== "object") return;
  for (const [name, spec] of Object.entries(overrides)) {
    if (isGitSpec(spec)) throw blockedGitSpecError(name, spec, label, owner);
  }
}

function blockedGitSpecError(name, spec, field, owner) {
  return new Error(
    `[pwrgit pnpmfile] Blocked git dependency ${name}@${spec}, ` +
      `declared in ${field}${owner ? ` of ${owner}` : ""}. ` +
      `Git specs bypass tarball integrity checks and run arbitrary ` +
      `lifecycle scripts against arbitrary remotes. If you need this ` +
      `package, publish a registry tarball or vendor the source.`
  );
}

// Workspace packages live under @pwrgit/* (plus the unscoped root
// `pwrgit-workspace`). Transitive packages from the registry never
// use these names, so a name check is a precise way to tell "is this
// our own code" without depending on pnpm-internal context this hook
// doesn't get.
function isWorkspaceRootPackage(pkg) {
  if (typeof pkg.name !== "string") return false;
  return pkg.name.startsWith("@pwrgit/") || pkg.name === "pwrgit-workspace";
}

// Belt-and-suspenders: even if a git spec somehow slipped past
// readPackage (e.g., transitive dep introduced via a registry
// package's manifest at fetch time), the corresponding pnpm fetcher
// itself refuses to run.
//
// pnpm's `hooks.fetchers` API treats each entry as a FACTORY function
// that's called with `({ defaultFetchers })` at fetcher-registry
// build time; the factory's RETURN VALUE is the actual fetcher pnpm
// invokes later when a dep needs fetching. So this function takes
// the factory shape (the arg is ignored — we're not delegating to a
// default) and returns the throwing fetcher.
function blockGitFetcher(/* { defaultFetchers } */) {
  return async () => {
    throw new Error(
      "[pwrgit pnpmfile] Blocked pnpm git dependency fetch. See .pnpmfile.cjs."
    );
  };
}

module.exports = {
  hooks: {
    readPackage,
    fetchers: {
      // `git`: direct git URL fetches (`git+ssh://`, `git@`, etc.)
      // `gitHostedTarball`: pnpm's shortcut for github/gitlab/bitbucket
      //   URLs and `user/repo` shortcuts — pnpm downloads a tarball of
      //   the resolved commit instead of cloning. Different fetcher,
      //   same supply-chain concern.
      git: blockGitFetcher,
      gitHostedTarball: blockGitFetcher
    }
  }
};
