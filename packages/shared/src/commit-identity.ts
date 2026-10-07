// Who a commit is recorded as, asked of Git rather than read off a profile.
//
// A profile stores an intention ("commit as this"). What Git records is a
// resolution over that intention plus every config scope, conditional
// include and environment variable in force. These types carry the
// resolution, so a surface never has to promise a value Git might not write.

/** A Git identity: the `Name <email>` half of an ident line. */
export type GitPerson = { name: string; email: string };

/** `git config --show-scope`'s answer, plus `command` for `-c`. */
export type GitConfigScope =
  | "system"
  | "global"
  | "local"
  | "worktree"
  | "command"
  | "unknown";

/** One identity- or signing-relevant config value, as Git lists it. */
export type IdentityConfigEntry = {
  /** Lower-cased key, e.g. `user.email`. */
  key: string;
  value: string;
  scope: GitConfigScope;
  /** The file it came from (a conditional include names the included file),
   *  or `command line` for `-c`. */
  origin: string;
};

/** An identity variable in the environment PwrGit was started with. */
export type IdentityEnvOverride = { variable: string; value: string };

/**
 * What a PwrGit commit in this checkout will record.
 *
 * Resolved by Git with the exact arguments and environment PwrGit commits
 * with, so it cannot drift from what is written. `ok: false` is the only
 * state that blocks committing: Git itself would refuse.
 */
export type PwrGitIdentityPrediction =
  | {
      ok: true;
      author: GitPerson;
      committer: GitPerson;
      /** `git` when the profile has no name (or no email) and Git's own
       *  config supplied it. */
      nameSource: "profile" | "git";
      emailSource: "profile" | "git";
    }
  | {
      ok: false;
      problem: "no_name" | "no_email" | "failed";
      /** Git's own words. */
      message: string;
    };

/**
 * What Git resolves without PwrGit's per-command identity: what a terminal or
 * an agent gets in the same place, unless its own command overrides it.
 *
 * `guessed` is Git committing with nothing configured. `source` says where
 * the address came from: the `EMAIL` environment variable a shell exported
 * (`environment`), or the login and host name (`system`) — macOS Git does the
 * latter and commits; Linux Git usually cannot and refuses, which is
 * `missing`.
 */
export type OutsideGitIdentity =
  | { kind: "configured"; author: GitPerson; committer: GitPerson }
  | { kind: "guessed"; author: GitPerson; source: "environment" | "system" }
  | { kind: "missing"; message: string };

/** One commit's recorded identities, newest first from HEAD. */
export type RecordedCommitIdentity = {
  hash: string;
  author: GitPerson;
  committer: GitPerson;
  /** `Co-authored-by:` trailer values, as written. */
  coAuthors: string[];
  /** Carries a signature header. Says nothing about whether it verifies. */
  signed: boolean;
};

/**
 * Whether Git signs the commits PwrGit writes here, and with what. Read from
 * config, never by trying: a signature attempt can prompt for a passphrase.
 */
export type CommitSigning =
  | { enabled: false }
  | {
      enabled: true;
      format: "openpgp" | "ssh" | "x509";
      /** `user.signingkey`; null means Git's default for the committer email. */
      key: string | null;
    };

/** `identity:inspect` — everything the commit footer and its popover show. */
export type CommitIdentityInspection = {
  worktreeId: string;
  profile: { name: string; email: string; authorName: string | null };
  pwrgit: PwrGitIdentityPrediction;
  outside: OutsideGitIdentity;
  /** Identity and signing config in force here, lowest precedence first. */
  config: IdentityConfigEntry[];
  /** Identity variables PwrGit inherited, which it removes from its own
   *  commits but a terminal started the same way would still apply. */
  env: IdentityEnvOverride[];
  /** Empty on an unborn branch. */
  recent: RecordedCommitIdentity[];
  signing: CommitSigning;
};

/**
 * The entry Git uses for `key`: config lists lowest precedence first, so the
 * last match wins. `scopes` narrows the search, for "what does this file hold"
 * rather than "what does Git use".
 */
export function lastConfigEntry(
  entries: readonly IdentityConfigEntry[],
  key: string,
  scopes?: readonly GitConfigScope[]
): IdentityConfigEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry === undefined || entry.key !== key) continue;
    if (scopes !== undefined && !scopes.includes(entry.scope)) continue;
    return entry;
  }
  return undefined;
}

/** `identity:machine` — Git's identity with no repository in the way. */
export type MachineGitIdentity = {
  outside: OutsideGitIdentity;
  /** `user.name` / `user.email` from global and system config. */
  config: IdentityConfigEntry[];
  /** The file `git config --global` writes on this machine. */
  globalFile: string;
  /** Whether the asking window should show the launch notice. Only one
   *  window is ever told yes, and never after it was dismissed this launch
   *  or switched off in Settings. */
  notice: boolean;
};

const NOREPLY_HOSTS: ReadonlyArray<{ suffix: string; forge: string }> = [
  { suffix: "@users.noreply.github.com", forge: "GitHub" },
  { suffix: "@users.noreply.gitlab.com", forge: "GitLab" }
];

/** The forge a private "noreply" address belongs to, or null. A noreply
 *  address is a valid choice that keeps an email private; surfaces label it
 *  rather than flag it. */
export function noreplyForge(email: string): string | null {
  const lower = email.toLowerCase();
  return NOREPLY_HOSTS.find((host) => lower.endsWith(host.suffix))?.forge ?? null;
}

/** `Name <email>`, as Git writes it. */
export function formatGitPerson(person: GitPerson): string {
  return `${person.name} <${person.email}>`;
}

export function samePerson(a: GitPerson, b: GitPerson): boolean {
  return a.name === b.name && a.email.toLowerCase() === b.email.toLowerCase();
}
