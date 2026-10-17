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

// ---------------------------------------------------------------------------
// Identity by folder: Git's `includeIf "gitdir:…"` per profile root.
// ---------------------------------------------------------------------------

/**
 * Where the email Git uses in one repository came from. `pwrgit` is PwrGit's
 * include for the repository's own profile; `pwrgit-other` is another
 * profile's (only possible when roots overlap); `include` is any include the
 * user wrote; `none` means Git would guess or refuse.
 */
export type FolderIdentitySource =
  | "pwrgit"
  | "pwrgit-other"
  | "global"
  | "include"
  | "local"
  | "system"
  | "none";

/** What Git outside PwrGit records in one indexed repository. */
export type FolderRepoIdentity = {
  repoId: string;
  name: string;
  path: string;
  /** The winning `author.email`, else `user.email`; null when neither is set. */
  email: string | null;
  /** The winning `author.name`, else `user.name`. */
  authorName: string | null;
  source: FolderIdentitySource;
  /** The file the winning email came from, or null with `none`. */
  origin: string | null;
  /** The email (and the name, when the profile sets one) equal the profile's. */
  matches: boolean;
};

/** A root shared with another profile: equal, or one inside the other. */
export type RootOverlap = {
  root: string;
  profileId: string;
  profileName: string;
  otherRoot: string;
  /** How `root` relates to `otherRoot`. */
  relation: "same" | "inside" | "contains";
};

export type FolderProfileIdentity = {
  profileId: string;
  name: string;
  mono: string;
  email: string;
  authorName: string | null;
  roots: string[];
  overlaps: RootOverlap[];
  /** The include file PwrGit writes for this profile. */
  includeFile: string;
  /** Indexed, visible repositories, by name. */
  repos: FolderRepoIdentity[];
};

/** `identity:folders`. */
export type FolderIdentityReport = {
  /** Settings › Profiles › "Match Git to each profile". */
  enabled: boolean;
  globalFile: string;
  /** Git's identity with no repository in the way, for profiles with no repos. */
  machine: OutsideGitIdentity;
  profiles: FolderProfileIdentity[];
};

/** One `[includeIf "<condition>"] path = <path>` entry. */
export type FolderInclude = { condition: string; path: string };

/** `identity:folderPlan` — what turning the switch on or off writes. */
export type FolderSyncPlan = {
  enabled: boolean;
  globalFile: string;
  /** PwrGit's includes now in the global file, removed first. */
  remove: FolderInclude[];
  /** Appended at the end of the global file, in this order. */
  add: FolderInclude[];
  /** Include files written (created or replaced). */
  files: { path: string; content: string; exists: boolean }[];
  /** PwrGit's include files no profile needs any more. */
  deleteFiles: string[];
  /** Profiles that get no include, and why. `unwritable`: the email or
   *  author name carries a control character a config file can't hold. */
  skipped: { profileId: string; name: string; reason: "no_email" | "no_roots" | "unwritable" }[];
};

/** Whether `platform`'s file system folds case, so two roots that differ only
 *  in case are one folder. Main, the profile editor and the report share it. */
export function foldsPathCase(platform: string): boolean {
  return platform === "darwin" || platform === "win32";
}

/** A root as compared: forward slashes, no trailing slash, optionally folded. */
export function comparableRoot(root: string, caseInsensitive: boolean): string {
  let path = root.trim().replace(/\\/g, "/");
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return caseInsensitive ? path.toLowerCase() : path;
}

/**
 * Roots in `roots` that equal, contain or sit inside a root of another
 * profile. A repository can belong to one profile — the indexer reassigns a
 * repo found under two — and its folder identity to one email.
 */
export function findRootOverlaps(
  roots: readonly string[],
  others: readonly { id: string; name: string; roots: readonly string[] }[],
  caseInsensitive: boolean
): RootOverlap[] {
  const overlaps: RootOverlap[] = [];
  for (const root of roots) {
    const mine = comparableRoot(root, caseInsensitive);
    if (mine === "") continue;
    for (const other of others) {
      for (const otherRoot of other.roots) {
        const theirs = comparableRoot(otherRoot, caseInsensitive);
        if (theirs === "") continue;
        const relation =
          mine === theirs
            ? "same"
            : mine.startsWith(`${theirs}/`)
              ? "inside"
              : theirs.startsWith(`${mine}/`)
                ? "contains"
                : null;
        if (relation !== null) {
          overlaps.push({ root, profileId: other.id, profileName: other.name, otherRoot, relation });
        }
      }
    }
  }
  return overlaps;
}

/** The sentence the profile editor shows for a refused root. */
export function rootOverlapMessage(overlap: RootOverlap): string {
  const where =
    overlap.relation === "same"
      ? `${overlap.root} is already a folder of “${overlap.profileName}”.`
      : overlap.relation === "inside"
        ? `${overlap.root} is inside ${overlap.otherRoot}, a folder of “${overlap.profileName}”.`
        : `${overlap.root} contains ${overlap.otherRoot}, a folder of “${overlap.profileName}”.`;
  return `${where} A repository can belong to one profile, and its Git identity to one email.`;
}
