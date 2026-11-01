import type { MaintenanceSummary } from "@pwrgit/shared";

/**
 * One thing a Combined maintenance step left behind, as a row of its outcome
 * card ("Maintenance Continues Past Errors" board, turn 3). A retained branch
 * is one row; a repository failure with no branch rows is one row. The
 * repository's own count sentence ("26 local branches deleted; 1 retained.")
 * is never a row: the card's head and the step line already say it.
 */
export type StepIssue = {
  /** `branch`: a retained branch. `review`: a repository whose branch review
   *  failed. `repo`: any other repository failure (deletion, refresh, GC).
   *  `run`: the command itself returned no results. */
  kind: "branch" | "review" | "repo" | "run";
  repo: string;
  path?: string;
  branch?: string;
  head?: string;
  /** Plain words. `lead` is its first sentence, drawn in danger ink. */
  reason: string;
  lead?: string;
  /** Git's own text, behind Details. */
  raw?: string;
  /** The repository was cancelled rather than failing. */
  cancelled?: boolean;
};

/** Which command produced a result, so its rows explain the right thing. */
export type IssueSource = "review" | "delete" | "gc";

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

/** The rows a command's result leaves for its step's card. */
export function stepIssues(result: MaintenanceSummary, source: IssueSource): StepIssue[] {
  return result.results.flatMap((row): StepIssue[] => {
    const where = { repo: row.repo.name, path: row.repo.path };
    const cancelled = row.outcome === "cancelled" ? { cancelled: true } : {};
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
