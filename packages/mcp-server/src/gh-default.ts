/**
 * Which repository `gh` treats as this checkout's base repository: the one
 * `gh pr create`, `gh issue list` and friends act on when no `--repo` is given.
 *
 * This is the GitHub CLI's own rule, transcribed from cli/cli
 * (`context/context.go` `ResolvedRemotes.BaseRepo`, `context/remote.go`
 * `remoteNameSortScore`, `git/client.go` `populateResolvedRemotes`):
 *
 * 1. Remotes are ranked `upstream` > `github` > `origin` > any other name
 *    (case-insensitive). `git remote -v` lists them alphabetically, and the
 *    sort keeps that order among equal ranks.
 * 2. The first ranked remote carrying `remote.<name>.gh-resolved` wins: `base`
 *    means that remote's own repository, anything else is an `owner/repo` on
 *    that remote's host. `gh repo set-default` writes this key.
 * 3. With no key and no terminal to prompt (an agent, a script), gh takes the
 *    first ranked remote. In a fork checkout with an `upstream` remote that is
 *    the ORIGINAL repository, so a bare `gh pr create` opens the PR there.
 *
 * Pure and dependency-free: the desktop app imports it too
 * (`@pwrgit/mcp-server/gh-default`), so both read one rule.
 */

/** One remote, already parsed by the caller's own remote parser. */
export type GhRemoteInput = {
  name: string;
  /** Lowercased hostname, or null when the URL did not parse. */
  host: string | null;
  /** `owner/name` as the remote spells it, or null when it did not parse. */
  repository: string | null;
  /** Whether gh would consider this host at all (a GitHub host). */
  github: boolean;
  /** The remote's `gh-resolved` value, or null when unset. */
  resolved: string | null;
};

export type GhDefaultCandidate = {
  host: string;
  repository: string;
  /** Every remote that points at this repository, in gh's rank order. */
  remotes: string[];
};

export type GhDefaultRepository = {
  /**
   * - `set`: `gh repo set-default` (a `gh-resolved` key) chose it.
   * - `implicit`: nothing is set, but every GitHub remote is the same
   *   repository, so there is nothing to get wrong.
   * - `ambiguous`: nothing is set and the GitHub remotes name different
   *   repositories. gh picks by remote NAME, not by where you push.
   * - `invalid`: a `gh-resolved` value gh cannot parse; gh commands fail.
   * - `none`: no GitHub remote, so gh has no default to pick.
   */
  status: "set" | "implicit" | "ambiguous" | "invalid" | "none";
  /** What a non-interactive `gh pr create` targets; null for `none`/`invalid`. */
  host: string | null;
  repository: string | null;
  /** The remote the answer came from. */
  remote: string | null;
  /** Distinct GitHub repositories across the remotes, in gh's rank order. */
  candidates: GhDefaultCandidate[];
  /**
   * The command that pins the default, offered only when the state is risky
   * (`ambiguous`, `invalid`). It names `origin`'s repository (where this
   * checkout pushes) when there is one; the user may want another candidate.
   * PwrGit never runs it: it writes shared `.git/config`.
   */
  fix: string | null;
};

/** cli/cli `remoteNameSortScore`. */
export function ghRemoteRank(name: string): number {
  switch (name.toLowerCase()) {
    case "upstream":
      return 3;
    case "github":
      return 2;
    case "origin":
      return 1;
    default:
      return 0;
  }
}

const FULL_NAME = /^[^/\s]+\/[^/\s]+$/;

function byteCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function key(host: string, repository: string): string {
  return `${host}\0${repository.toLowerCase()}`;
}

function setDefaultCommand(host: string, repository: string): string {
  // `gh repo set-default` takes `[HOST/]OWNER/REPO`; github.com needs no host.
  const target = host === "github.com" ? repository : `${host}/${repository}`;
  return `gh repo set-default ${target}`;
}

export function resolveGhDefaultRepository(
  remotes: ReadonlyArray<GhRemoteInput>
): GhDefaultRepository {
  // gh drops remotes on hosts it does not know and URLs it cannot read as a
  // repository, then ranks what is left. Git lists names alphabetically
  // (byte order); the sort is stable over that.
  const ranked = remotes
    .filter(
      (remote): remote is GhRemoteInput & { host: string; repository: string } =>
        remote.github && remote.host !== null && remote.repository !== null
    )
    .sort(
      (left, right) =>
        ghRemoteRank(right.name) - ghRemoteRank(left.name) ||
        byteCompare(left.name, right.name)
    );

  const byRepository = new Map<string, GhDefaultCandidate>();
  for (const remote of ranked) {
    const id = key(remote.host, remote.repository);
    const existing = byRepository.get(id);
    if (existing === undefined) {
      byRepository.set(id, {
        host: remote.host,
        repository: remote.repository,
        remotes: [remote.name]
      });
    } else {
      existing.remotes.push(remote.name);
    }
  }
  const candidates = [...byRepository.values()];
  const first = ranked[0];
  if (first === undefined) {
    return { status: "none", host: null, repository: null, remote: null, candidates, fix: null };
  }

  const origin = ranked.find((remote) => remote.name === "origin");
  const suggestion = setDefaultCommand(
    (origin ?? first).host,
    (origin ?? first).repository
  );

  const chosen = ranked.find((remote) => (remote.resolved ?? "") !== "");
  if (chosen !== undefined) {
    const value = (chosen.resolved ?? "").trim();
    if (value === "base") {
      return {
        status: "set",
        host: chosen.host,
        repository: chosen.repository,
        remote: chosen.name,
        candidates,
        fix: null
      };
    }
    if (FULL_NAME.test(value)) {
      return {
        status: "set",
        host: chosen.host,
        repository: value,
        remote: chosen.name,
        candidates,
        fix: null
      };
    }
    return {
      status: "invalid",
      host: null,
      repository: null,
      remote: chosen.name,
      candidates,
      fix: suggestion
    };
  }

  const ambiguous = candidates.length > 1;
  return {
    status: ambiguous ? "ambiguous" : "implicit",
    host: first.host,
    repository: first.repository,
    remote: first.name,
    candidates,
    fix: ambiguous ? suggestion : null
  };
}

/** `git config --get-regexp '^remote\..*\.gh-resolved$'` output → name → value.
 *  Split like gh does: the key on its first two dots, the value after the
 *  first space. */
export function parseGhResolvedConfig(stdout: string): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const configKey = line.slice(0, space);
    const value = line.slice(space + 1).trim();
    const name = configKey.split(".", 3)[1];
    if (name === undefined || name === "" || value === "") continue;
    // gh assigns every line in turn, so a repeated key's LAST value wins.
    resolved.set(name, value);
  }
  return resolved;
}

/** The sentence an agent or a person reads. Null when there is nothing to say. */
export function describeGhDefaultRisk(state: GhDefaultRepository): string | null {
  if (state.status === "ambiguous") {
    const others = state.candidates
      .filter((candidate) => candidate.repository !== state.repository || candidate.host !== state.host)
      .map((candidate) => `${candidate.repository} (${candidate.remotes.join(", ")})`)
      .join(", ");
    return (
      `No gh default repository is set. A non-interactive \`gh pr create\` would target ` +
      `${state.repository} (remote ${state.remote}), not ${others}. ` +
      `Pass --repo, or run \`${state.fix}\`.`
    );
  }
  if (state.status === "invalid") {
    return (
      `remote.${state.remote}.gh-resolved is not "base" or OWNER/REPO, so gh commands ` +
      `that need a repository will fail. Run \`${state.fix}\` to replace it.`
    );
  }
  return null;
}
