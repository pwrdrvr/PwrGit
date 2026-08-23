import {
  err,
  ok,
  PWRGIT_PULL_STASH_MESSAGE,
  type PwrGitError,
  type Result,
  type StashDetails,
  type StashEntry,
  type StashFileSummary
} from "@pwrgit/shared";
import {
  NO_OPTIONAL_LOCKS,
  requireExit0,
  type GitExec,
  type GitOutput
} from "./dugite";

const FIELD_SEPARATOR = "\x1f";
const RECORD_SEPARATOR = "\x1e";
const STASH_FORMAT = ["%H", "%h", "%P", "%cI", "%gs"].join(
  "%x1f"
) + "%x1e";

/**
 * Parse `git stash list` without depending on its human presentation. Subjects
 * cannot carry newlines (`%gs` is one line); control separators keep spaces,
 * tabs, and non-ASCII stash names intact.
 */
export function parseStashList(stdout: string): StashEntry[] {
  const parsed: Omit<StashEntry, "occurrenceCount">[] = [];
  for (const rawRecord of stdout.split(RECORD_SEPARATOR)) {
    const record = rawRecord.replace(/^\r?\n+/, "");
    if (record === "") continue;
    const [hash, shortHash, parents, createdAt, subject] =
      record.split(FIELD_SEPARATOR);
    if (
      hash === undefined ||
      shortHash === undefined ||
      parents === undefined ||
      createdAt === undefined ||
      subject === undefined
    ) {
      continue;
    }
    const identity = /^(WIP on|On) ([^:]+): (.*)$/.exec(subject);
    const named = identity?.[1] === "On" ? identity[3] : undefined;
    parsed.push({
      selector: `stash@{${parsed.length}}`,
      hash,
      shortHash,
      baseHash: parents.split(" ")[0] ?? "",
      branch: identity?.[2] ?? null,
      subject,
      ...(named === undefined ? {} : { name: named }),
      kind:
        named === PWRGIT_PULL_STASH_MESSAGE
          ? "pwrgit-pull-recovery"
          : "ordinary",
      createdAt
    });
  }
  const occurrences = new Map<string, number>();
  for (const entry of parsed) {
    occurrences.set(entry.hash, (occurrences.get(entry.hash) ?? 0) + 1);
  }
  return parsed.map((entry) => ({
    ...entry,
    occurrenceCount: occurrences.get(entry.hash) ?? 1
  }));
}

export async function listStashes(
  git: GitExec,
  cwd: string
): Promise<Result<StashEntry[]>> {
  const args = ["stash", "list", `--format=${STASH_FORMAT}`];
  const raw = await git(args, cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  return checked.ok ? ok(parseStashList(checked.value.stdout)) : checked;
}

/** `--no-renames` makes each NUL record exactly add<TAB>del<TAB>path. */
export function parseStashNumstat(stdout: string): StashFileSummary[] {
  const files: StashFileSummary[] = [];
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    if (path === "") continue;
    files.push({
      path,
      additions: added === "-" ? null : Number.parseInt(added, 10),
      deletions: deleted === "-" ? null : Number.parseInt(deleted, 10)
    });
  }
  return files;
}

export async function readStashDetails(
  git: GitExec,
  cwd: string,
  entry: StashEntry
): Promise<Result<StashDetails>> {
  const args = [
    "stash",
    "show",
    "--include-untracked",
    "--numstat",
    "--no-renames",
    "-z",
    entry.hash
  ];
  const raw = await git(args, cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  const files = parseStashNumstat(checked.value.stdout);
  return ok({
    entry,
    files,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  });
}

export async function readStashPatch(
  git: GitExec,
  cwd: string,
  selector: string
): Promise<Result<string>> {
  const args = [
    "stash",
    "show",
    "--include-untracked",
    "--patch",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    selector
  ];
  const raw = await git(args, cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  return checked.ok ? ok(checked.value.stdout) : checked;
}

async function currentStashHash(
  git: GitExec,
  cwd: string
): Promise<Result<string | null>> {
  const args = ["rev-parse", "--verify", "refs/stash"];
  const raw = await git(args, cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok) return raw;
  if (raw.value.exitCode === 1 || raw.value.exitCode === 128) return ok(null);
  const checked = requireExit0(raw.value, args);
  return checked.ok ? ok(checked.value.stdout.trim()) : checked;
}

export async function createStash(
  git: GitExec,
  cwd: string,
  message: string,
  includeUntracked: boolean
): Promise<Result<boolean>> {
  const before = await currentStashHash(git, cwd);
  if (!before.ok) return before;
  const args = [
    "stash",
    "push",
    ...(includeUntracked ? ["--include-untracked"] : []),
    "--message",
    message
  ];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  const after = await currentStashHash(git, cwd);
  if (!after.ok) return after;
  return ok(after.value !== null && after.value !== before.value);
}

/** Include both streams: conflict details are split differently across Git versions. */
function stashMutationResult(
  output: GitOutput,
  args: string[]
): Result<void, PwrGitError> {
  if (output.exitCode === 0) return ok(undefined);
  const detail = [output.stderr.trim(), output.stdout.trim()]
    .filter((part) => part !== "")
    .join("\n");
  return err({
    kind: "git",
    code: `exit_${output.exitCode}`,
    message:
      detail === ""
        ? `git ${args.join(" ")} exited ${output.exitCode}`
        : detail
  });
}

async function mutateStash(
  git: GitExec,
  cwd: string,
  verb: "apply" | "pop" | "drop",
  selector: string
): Promise<Result<void>> {
  const args = ["stash", verb, selector];
  const raw = await git(args, cwd);
  return raw.ok ? stashMutationResult(raw.value, args) : raw;
}

export const applyStash = (
  git: GitExec,
  cwd: string,
  selector: string
): Promise<Result<void>> => mutateStash(git, cwd, "apply", selector);

export const popStash = (
  git: GitExec,
  cwd: string,
  selector: string
): Promise<Result<void>> => mutateStash(git, cwd, "pop", selector);

export const dropStash = (
  git: GitExec,
  cwd: string,
  selector: string
): Promise<Result<void>> => mutateStash(git, cwd, "drop", selector);
