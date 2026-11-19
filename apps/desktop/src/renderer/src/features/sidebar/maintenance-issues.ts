import { RESHARE_ARGS, type MaintenanceRepoResult, type MaintenanceSummary, type ReshareWorktreeResult } from "@pwrgit/shared";

/**
 * One thing a Combined maintenance step left behind, as a row of its outcome
 * card ("Maintenance Continues Past Errors" board, turn 3). A retained branch
 * is one row; a repository failure with no branch rows is one row. The
 * repository's own count sentence ("26 local branches deleted; 1 retained.")
 * is never a row: the card's head and the step line already say it. Clones
 * reports per worktree, so each worktree it failed in is a row of its own
 * (turn 4), with its path and Git's words.
 */
export type StepIssue = {
  /** `branch`: a retained branch. `review`: a repository whose branch review
   *  failed. `repo`: any other repository failure (deletion, refresh, GC).
   *  `run`: the command itself returned no results. `worktree`: a linked
   *  worktree Clones could not re-share. */
  kind: "branch" | "review" | "repo" | "run" | "worktree";
  repo: string;
  /** The repository's path; a `worktree` row's own path is the worktree's. */
  path?: string;
  /** A `worktree` row's repository path. */
  repoPath?: string;
  branch?: string;
  head?: string;
  /** Plain words. `lead` is its first sentence, drawn in danger ink. */
  reason: string;
  lead?: string;
  /** Git's own text, behind Details. */
  raw?: string;
  /** The Git command a `worktree` row ran, and how it exited. */
  command?: string;
  exitCode?: number;
  /** The repository was cancelled rather than failing. */
  cancelled?: boolean;
};

/** Which command produced a result, so its rows explain the right thing. */
export type IssueSource = "review" | "delete" | "gc" | "repair" | "clones";

const RAW_GIT = /^(?:error|fatal|warning|usage):/i;
/** Git's own output, not a sentence PwrGit wrote: it never leads a row. */
export const looksLikeRawGit = (message: string): boolean =>
  RAW_GIT.test(message.trimStart()) || message.trim().includes("\n");
const firstSentence = (message: string): string | undefined =>
  /^[\s\S]*?[.!?](?=\s|$)/.exec(message)?.[0];
/** Main's per-repository count line for a deletion. */
const DELETION_COUNT = /^\d+ local branch(?:es)? deleted; \d+ retained\.\s*/;
const REVIEW_LEAD = "Couldn’t review its branches.";

function explain(message: string, rawReason: string): Pick<StepIssue, "reason" | "lead" | "raw"> {
  if (looksLikeRawGit(message)) return { reason: rawReason, lead: rawReason, raw: message.trim() };
  const lead = firstSentence(message);
  return lead === undefined ? { reason: message } : { reason: message, lead };
}

const RESHARE_LEAD = "Git couldn’t re-share it.";
const BROKEN_LINK_LEAD = "Git couldn’t open this worktree.";
/** Git's words for a worktree whose `.git` file points at no repository,
 *  as a moved repository leaves it. */
const BROKEN_LINK = /gitfile does not point to a valid repository|not a git repository/i;
const RESHARE_COMMAND = `git ${RESHARE_ARGS.join(" ")}`;

/** A worktree Clones failed in, as its row: PwrGit's sentence leads, and
 *  Git's own words (already sanitized by main) sit behind Details. */
function worktreeIssue(repo: MaintenanceRepoResult["repo"], worktree: ReshareWorktreeResult): StepIssue {
  const git = worktree.gitError;
  // Main appends Git's words to its count sentence; the row shows them once.
  const own = git !== undefined && worktree.message.endsWith(git)
    ? worktree.message.slice(0, worktree.message.length - git.length).trim()
    : worktree.message;
  const raw = git ?? (looksLikeRawGit(own) ? own.trim() : undefined);
  const words: Pick<StepIssue, "reason" | "lead"> =
    own !== "" && !looksLikeRawGit(own)
      ? { reason: own, lead: firstSentence(own) ?? own }
      : raw !== undefined && BROKEN_LINK.test(raw)
        ? { reason: `${BROKEN_LINK_LEAD} Its .git link points to a folder that isn’t a repository. Repair links can re-point it; then run Clones again.`, lead: BROKEN_LINK_LEAD }
        : { reason: RESHARE_LEAD, lead: RESHARE_LEAD };
  return {
    kind: "worktree",
    repo: repo.name,
    repoPath: repo.path,
    path: worktree.path,
    branch: worktree.branch,
    ...words,
    ...(raw === undefined ? {} : { raw }),
    command: RESHARE_COMMAND,
    ...(worktree.exitCode === undefined ? {} : { exitCode: worktree.exitCode })
  };
}

/** A Clones repository's rows: each failed worktree, and a main checkout that
 *  failed to update. Null when neither happened, so the repository's own
 *  failure (or cancellation) is its row. */
function clonesIssues(row: MaintenanceRepoResult): StepIssue[] | null {
  const report = row.reshare;
  if (report === undefined) return null;
  const main: StepIssue[] = report.main.outcome === "failed"
    ? [{ kind: "repo", repo: row.repo.name, path: row.repo.path, ...explain(report.main.message, "Git couldn’t update the main checkout.") }]
    : [];
  const worktrees = report.worktrees
    .filter((worktree) => worktree.outcome === "failed")
    .map((worktree) => worktreeIssue(row.repo, worktree));
  return main.length + worktrees.length === 0 ? null : [...main, ...worktrees];
}

/** The rows a command's result leaves for its step's card. */
export function stepIssues(result: MaintenanceSummary, source: IssueSource): StepIssue[] {
  return result.results.flatMap((row): StepIssue[] => {
    const where = { repo: row.repo.name, path: row.repo.path };
    const cancelled = row.outcome === "cancelled" ? { cancelled: true } : {};
    if (source === "clones") {
      const rows = clonesIssues(row);
      if (rows !== null) return rows;
    }
    const retained = (row.branches ?? []).filter((branch) => !branch.deleted).map((branch): StepIssue => ({
      kind: "branch", ...where, branch: branch.branch, head: branch.head, ...cancelled,
      ...explain(branch.message, "Git refused to delete it.")
    }));
    if (row.outcome !== "failed" && row.outcome !== "partial" && row.outcome !== "cancelled") return retained;
    // A deletion's message opens with its count; what follows (a refresh
    // failure) is a problem of its own, even beside branch rows.
    const own = source === "delete" ? row.message.replace(DELETION_COUNT, "").trim() : row.message;
    if (retained.length > 0 && own === "") return retained;
    const message = own === "" ? row.message : own;
    if (source === "review") {
      const words = looksLikeRawGit(message)
        ? { reason: REVIEW_LEAD, lead: REVIEW_LEAD, raw: message.trim() }
        : { reason: `${REVIEW_LEAD} ${message}`, lead: REVIEW_LEAD };
      return [...retained, { kind: "review", ...where, ...cancelled, ...words }];
    }
    return [...retained, { kind: "repo", ...where, ...cancelled, ...explain(message, "Git reported an error.") }];
  });
}

/** A command that answered with an error rather than repository results.
 *  It belongs to no repository, so its row shows only the reason. */
export function runIssue(message: string): StepIssue {
  return { kind: "run", repo: "", ...explain(message, "Git reported an error.") };
}

const repositories = (count: number): string =>
  `${count} ${count === 1 ? "repository" : "repositories"}`;
const tally = (issues: StepIssue[], kind: StepIssue["kind"]): number =>
  issues.filter((issue) => issue.kind === kind).length;

/** The Local branches step line, counting branches rather than repositories:
 *  "26 deleted in 1 repository · 1 not deleted · 1 not reviewed". */
export function branchStepLine(lead: string, issues: StepIssue[]): string {
  const notDeleted = tally(issues, "branch");
  const notReviewed = tally(issues, "review");
  const other = issues.length - notDeleted - notReviewed;
  return `${lead}${notDeleted > 0 ? ` · ${notDeleted} not deleted` : ""}${notReviewed > 0 ? ` · ${notReviewed} not reviewed` : ""}${other > 0 ? ` · ${other} ${other === 1 ? "problem" : "problems"}` : ""}`;
}
export const deletedLead = (deleted: number, repos: number): string =>
  `${deleted} deleted${repos > 0 ? ` in ${repositories(repos)}` : ""}`;

/** The Garbage collection step line: "81 collected · 1.2 GiB → 1.0 GiB · 1 failed". */
export const gcStepLine = (collected: number, storage: string, issues: StepIssue[]): string =>
  `${collected} collected${storage}${issues.length > 0 ? ` · ${issues.length} failed` : ""}`;

/** The Clones step line: "6.18 GiB now shared · 41 worktrees · 1 failed".
 *  `shared` is Git's own count, already formatted; null when Git measured
 *  nothing, which is not zero. Never "freed": see main/git/AGENTS.md. */
export function clonesStepLine(shared: string | null, files: number, worktrees: number, issues: StepIssue[]): string {
  const lead = files === 0 ? "Nothing new to share" : shared === null ? `${files.toLocaleString("en-US")} ${files === 1 ? "file" : "files"} re-shared` : `${shared} now shared`;
  return `${lead} · ${worktrees.toLocaleString("en-US")} ${worktrees === 1 ? "worktree" : "worktrees"}${issues.length > 0 ? ` · ${issues.length} failed` : ""}`;
}

/** Head of the Clones card. Sharing only ever leaves files as they were.
 *  `worktrees` is how many linked worktrees the step covered. */
export function clonesCardCopy(issues: StepIssue[], worktrees = 0): CardCopy {
  if (issues.every((issue) => issue.kind === "run"))
    return { headline: "Clones couldn’t run", sub: "Maintenance stopped here.", listLabel: "Repositories not shared" };
  const repos = new Set(issues.map((issue) => issue.repoPath ?? issue.path ?? issue.repo)).size;
  const sub = "Files Git did not share are left exactly as they were.";
  if (issues.every((issue) => issue.kind === "worktree")) {
    const others = worktrees - issues.length;
    return {
      headline: `${issues.length} ${issues.length === 1 ? "worktree" : "worktrees"} couldn’t be re-shared in ${repositories(repos)}`,
      sub: others > 0 ? `${sub} The other ${others.toLocaleString("en-US")} ${others === 1 ? "worktree" : "worktrees"} ran.` : sub,
      listLabel: "Worktrees not re-shared"
    };
  }
  return {
    headline: `Clones: ${issues.length} ${issues.length === 1 ? "problem" : "problems"} in ${repositories(repos)}`,
    sub,
    listLabel: "Clones problems"
  };
}

/** One row as plain text for the clipboard: what failed, where, and what Git
 *  said. It holds nothing the maintenance log does not. */
export function issueReport(issue: StepIssue, step: string): string {
  const name = [issue.repo, issue.branch === undefined ? null : issue.branch || "detached"].filter((part) => part !== null && part !== "").join(" · ");
  return [
    `${step} failed${name === "" ? "" : `: ${name}`}`,
    issue.kind === "worktree" && issue.path !== undefined ? `Worktree: ${issue.path}` : null,
    (issue.repoPath ?? issue.path) !== undefined ? `Repository: ${issue.repoPath ?? issue.path}` : null,
    `Reason: ${issue.reason}`,
    issue.command === undefined ? null : `Command: ${issue.command}`,
    issue.exitCode === undefined ? null : `Exit code: ${issue.exitCode}`,
    issue.raw === undefined ? null : `Git: ${issue.raw}`
  ].filter((line): line is string => line !== null).join("\n");
}

/** Every row of a card, under its headline, for Copy all. */
export const issuesReport = (headline: string, issues: StepIssue[], step: string): string =>
  [headline, ...issues.map((issue) => issueReport(issue, step))].join("\n\n");

/** Splits a step line into its result and its issue counts ("1 not
 *  deleted", "2 failed"), so only the counts draw in danger ink. */
export function splitStepLine(line: string): { lead: string; issues: string } {
  const at = line.search(/ · \d+ (?:not deleted|not reviewed|problems?|failed)\b/);
  return at < 0 ? { lead: line, issues: "" } : { lead: line.slice(0, at), issues: line.slice(at) };
}

export type CardCopy = { headline: string; sub: string; listLabel: string };

/** Whether garbage collection ran after the branch step, for its sub-line. */
export type GcAfter = "ran" | "running" | "none";

/** Head of the Local branches card. `deleted` is how many the step did
 *  delete. `gcCard`: garbage collection has its own card, which speaks for
 *  itself, so this sub-line does not mention it. */
export function branchCardCopy(issues: StepIssue[], deleted: number, gc: GcAfter, gcCard = false): CardCopy {
  // A command error belongs to no repository: it stops the run but is not
  // counted among the repositories' problems.
  const listed = issues.filter((issue) => issue.kind !== "run");
  const stoppedByRun = listed.length < issues.length;
  const count = listed.length;
  const one = count === 1;
  if (count === 0)
    return { headline: "Local branches couldn’t run", sub: "Maintenance stopped here.", listLabel: "Local branch problems" };
  const branchesOnly = listed.every((issue) => issue.kind === "branch");
  const reviewOnly = listed.every((issue) => issue.kind === "review");
  const repoCount = new Set(listed.map((issue) => issue.path ?? issue.repo)).size;
  const headline = branchesOnly
    ? one ? "1 branch wasn’t deleted" : `${count} branches weren’t deleted`
    : reviewOnly
      ? `Local branches couldn’t be reviewed in ${repositories(count)}`
      : `Local branches: ${count} ${one ? "problem" : "problems"} in ${repositories(repoCount)}`;
  const state = branchesOnly
    ? one ? "It’s unchanged." : "They’re unchanged."
    : one ? "Nothing in it was deleted." : "Nothing in them was deleted.";
  const others = deleted === 0 ? "" : deleted === 1
    ? branchesOnly ? " The other one was deleted" : " The other branch was deleted"
    : ` The other ${deleted} ${branchesOnly ? "were" : "branches were"} deleted`;
  const end = deleted > 0 ? "." : "";
  const after = stoppedByRun
    ? `${end} Maintenance stopped here.`
    : gcCard || gc === "none"
      ? end
      : gc === "ran"
        ? deleted > 0 ? ", and garbage collection still ran." : " Garbage collection still ran."
        : deleted > 0 ? "; collection is still running." : " Collection is still running.";
  return {
    headline,
    sub: `${state}${others}${after}`,
    listLabel: branchesOnly ? "Branches not deleted" : reviewOnly ? "Repositories not reviewed" : "Local branch problems"
  };
}

/** Head of the Garbage collection card. `collected` succeeded. */
export function gcCardCopy(issues: StepIssue[], collected: number): CardCopy {
  const count = issues.length;
  const one = count === 1;
  if (issues.every((issue) => issue.kind === "run"))
    return { headline: "Garbage collection couldn’t run", sub: "Maintenance stopped here.", listLabel: "Repositories not collected" };
  const headline = issues.every((issue) => issue.cancelled === true)
    ? `Garbage collection didn’t run in ${repositories(count)}`
    : `Garbage collection failed in ${repositories(count)}`;
  return {
    headline,
    sub: `${one ? "Its objects are unchanged." : "Their objects are unchanged."}${collected === 1 ? " The other repository was collected." : collected > 1 ? ` The other ${collected} were collected.` : ""}`,
    listLabel: "Repositories not collected"
  };
}
