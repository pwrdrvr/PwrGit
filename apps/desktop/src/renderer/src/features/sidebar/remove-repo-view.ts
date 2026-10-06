import {
  canPushCheckout,
  checkoutVerdict,
  formatBytes,
  type RemovalCheckout,
  type RemovalStatus,
  type RemovalStep,
  type Repo,
  type RepoRemovalResult,
  type RepoRemovalReview
} from "@pwrgit/shared";

// The words of the Remove repository dialog, kept out of JSX so they can be
// tested. design/Remove and Hide Repository - UX Review.dc.html, turn 2.

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** A checkout's name in the list: its branch, or where a detached HEAD is. */
export function checkoutLabel(checkout: RemovalCheckout): string {
  if (checkout.branch !== "") return checkout.branch;
  return checkout.head === "" ? "detached HEAD" : `detached@${checkout.head.slice(0, 7)}`;
}

/** What the review found, as one line. Safe says why it is safe. */
export function checkoutFacts(checkout: RemovalCheckout): string {
  if (checkout.missing) {
    return "Folder not found. It may be on a volume that is not mounted.";
  }
  if (checkout.inspectError !== null) {
    return `Git could not inspect it: ${checkout.inspectError.split("\n")[0]}`;
  }
  if (checkout.locked) return "Locked with git worktree lock.";
  if (checkout.inProgress !== null) {
    return `A ${checkout.inProgress} is in progress. Finish or abort the ${checkout.inProgress} first.`;
  }
  const parts: string[] = [];
  if (checkout.uncommitted > 0) parts.push(plural(checkout.uncommitted, "uncommitted file"));
  if (checkout.untracked > 0) parts.push(plural(checkout.untracked, "untracked file"));
  if (checkout.conflicted > 0) parts.push(plural(checkout.conflicted, "conflicted file"));
  if (checkout.unpushed > 0) {
    parts.push(
      checkout.upstream === null && checkout.branch !== ""
        ? `${plural(checkout.unpushed, "commit")}, never pushed`
        : plural(checkout.unpushed, "unpushed commit")
    );
  }
  if (parts.length > 0) return parts.join(" · ");
  return checkout.upstream === null
    ? "Clean. Every commit is on a remote."
    : `Clean. Matches ${checkout.upstream}.`;
}

/** Why Push first is missing from an at-risk row that has commits to push. */
export function pushOffReason(checkout: RemovalCheckout): string | null {
  if (checkout.unpushed === 0 || canPushCheckout(checkout)) return null;
  if (checkoutVerdict(checkout) !== "at_risk") return null;
  const commits = plural(checkout.unpushed, "commit");
  if (checkout.branch === "") {
    return `Push first is off: a detached HEAD has no branch to push the ${commits} to.`;
  }
  if (checkout.pushRemote === null) {
    return `Push first is off: this repository has no remote to push the ${commits} to.`;
  }
  const files = checkout.uncommitted + checkout.untracked + checkout.conflicted;
  return `Push first is off: it would save the ${commits} but not the ${plural(files, "uncommitted file")}.`;
}

export const verdictLabel = {
  safe: "safe",
  at_risk: "at risk",
  blocked: "blocked"
} as const;

/** Footer status: what still stands between the user and the button. */
export function statusLine(status: RemovalStatus): string {
  const parts: string[] = [];
  if (status.undecided > 0) {
    parts.push(`${status.undecided} ${status.undecided === 1 ? "needs" : "need"} a choice`);
  }
  if (status.blocked > 0) parts.push(`${status.blocked} blocked`);
  parts.push(`${status.safe} safe`);
  return parts.join(" · ");
}

export function sizeLabel(bytes: number, partial: boolean): string {
  return partial ? `at least ${formatBytes(bytes)}` : formatBytes(bytes);
}

/** The danger button. A partial removal names worktrees, not folders: the
 *  repository is staying. */
export function removeButtonLabel(review: RepoRemovalReview, status: RemovalStatus): string {
  if (status.needsName) return `Remove ${review.name}`;
  if (status.partial) {
    const n = status.removeWorktreeIds.length;
    return `Remove ${plural(n, "worktree")}`;
  }
  return `Move ${plural(status.folderCount, "folder")} to Trash`;
}

export function partialCallout(review: RepoRemovalReview, status: RemovalStatus): string {
  const n = status.removeWorktreeIds.length;
  const doing =
    n === 0 ? "Nothing is removed yet" : `This removes ${plural(n, "worktree")}`;
  return `Keeping a worktree, a stash or a branch keeps the main checkout: they live in its .git. ${doing}; ${review.name} stays in PwrGit.`;
}

export function stepLabel(step: RemovalStep): string {
  if (step.isPrimary) return `Main checkout ${step.path} to the Trash`;
  if (step.kind === "forget") return `Clear the record of ${step.label}`;
  if (step.kind === "delete") return `Delete ${step.label} permanently`;
  return `${step.label} to the Trash`;
}

export function resultHeadline(
  review: RepoRemovalReview,
  result: RepoRemovalResult
): { title: string; message: string } {
  const failed = result.steps.filter((s) => s.status === "failed").length;
  const moved = result.steps.filter((s) => s.status === "done" && s.kind !== "forget");
  const bytes = moved.reduce((sum, step) => {
    const checkout = review.checkouts.find((c) => c.worktreeId === step.worktreeId);
    return sum + (checkout?.bytes ?? 0);
  }, 0);
  const anyDeleted = moved.some((s) => s.kind === "delete");
  const verb = moved.length === 1 ? "is" : "are";
  const where = anyDeleted ? `${verb} gone` : `${verb} in the Trash`;
  const size = bytes > 0 ? `, ${formatBytes(bytes)},` : "";
  if (result.outcome === "stopped") {
    return {
      title: `Stopped: ${plural(failed, "folder")} could not be moved`,
      message:
        "The main checkout was not touched. Retry, or reveal the folder to see what holds it."
    };
  }
  if (result.outcome === "partial") {
    return {
      title: `Removed ${plural(moved.length + result.steps.filter((s) => s.kind === "forget" && s.status === "done").length, "worktree")}`,
      message: `${plural(moved.length, "folder")}${size} ${where}. ${review.name} stays in PwrGit.`
    };
  }
  return {
    title: `Removed ${review.name}`,
    message: `${plural(moved.length, "folder")}${size} ${where}. It is gone from this profile and will not come back in a scan. The remote still has every pushed branch.`
  };
}

/** The toast after Hide: where the repository went, and what went with it. */
export function hiddenToast(repo: Repo): { title: string; message: string } {
  const linked = repo.worktrees.filter((w) => !w.isPrimary).length;
  const worktrees =
    linked === 0
      ? ""
      : linked === 1
        ? " Its worktree is hidden with it."
        : ` Its ${linked} worktrees are hidden with it.`;
  return {
    title: `Hid ${repo.name}`,
    message: `It stays on disk and out of this profile's sidebar, search, Fetch all and Try pull all.${worktrees}`
  };
}
