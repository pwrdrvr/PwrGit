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
};

export type SetupIgnoreTest = {
  path: string;
  ignored: boolean;
  source: string | null;
  line: number | null;
  pattern: string | null;
};
