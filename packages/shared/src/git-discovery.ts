/** Evidence from Git's trace2 child_start/child_exit pair, not a guessed hook. */
export type HookRun = {
  name: string;
  path: string;
  exitCode: number;
  elapsedMs: number;
};

export type IgnoreDestination = "gitignore" | "exclude" | "global";
export type IgnorePatternChoice = "file" | "folder" | "extension";

export type IgnoreOption = {
  choice: IgnorePatternChoice;
  pattern: string;
  count: number;
};

export type IgnoreDestinationOption = {
  destination: IgnoreDestination;
  path: string;
  displayPath: string;
  scope: string;
};

export type IgnoreOptions = {
  patterns: IgnoreOption[];
  destinations: IgnoreDestinationOption[];
  suggested: IgnoreDestination;
  worktreeCount: number;
};

export type IgnoredRule = {
  source: string;
  line: number;
  pattern: string;
  count: number;
  destination: Exclude<IgnoreDestination, "gitignore">;
};

export type IgnoredSummary = { count: number; rules: IgnoredRule[]; worktreeCount: number };

export type SetupHook = {
  name: string;
  path: string;
  displayPath: string;
  calls: string;
  lastRun?: HookRun & { at: number };
};

export type SetupIgnoreLine = { number: number; text: string };
export type SetupIgnoreLayer = IgnoreDestinationOption & {
  lines: SetupIgnoreLine[];
  content: string;
};

/**
 * The repository the GitHub CLI acts on in this clone when no `--repo` is
 * given: what `gh pr create` opens a PR against. The rule (gh ranks remotes
 * `upstream` > `github` > `origin` > others unless `gh repo set-default`
 * wrote `remote.<name>.gh-resolved`) lives in `@pwrgit/mcp-server/gh-default`,
 * which main calls; this is its result, so the renderer need not import it.
 *
 * `ambiguous` and `invalid` are the risky states: `warning` says why and `fix`
 * is the command to run. PwrGit never runs it (it writes shared .git/config).
 */
export type GhDefaultRepository = {
  status: "set" | "implicit" | "ambiguous" | "invalid" | "none";
  host: string | null;
  repository: string | null;
  remote: string | null;
  candidates: { host: string; repository: string; remotes: string[] }[];
  fix: string | null;
  warning: string | null;
};

export type RepositorySetup = {
  hooks: {
    directory: string;
    displayDirectory: string;
    configuredPath: string | null;
    origin: string | null;
    manager: string | null;
    active: SetupHook[];
    shadowed: SetupHook[];
    sampleCount: number;
    lfsShadowed: boolean;
    worktreeCount: number;
  };
  ignore: SetupIgnoreLayer[];
  /** Null when the remotes could not be read. */
  ghDefault: GhDefaultRepository | null;
};

export type SetupIgnoreTest = {
  path: string;
  ignored: boolean;
  source: string | null;
  line: number | null;
  pattern: string | null;
};
