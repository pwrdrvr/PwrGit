import {
  BRANCH_CHECKOUT_TARGET_DEFAULT,
  isBranchCheckoutTarget,
  type BranchCheckoutTarget
} from "@pwrgit/shared";

const STORAGE_KEY = "pwrgit.branchCheckoutTarget";

/**
 * Turn a commit subject into a branch-name suggestion: drop a conventional
 * commit's type/scope prefix and its trailing PR number, then slugify what
 * describes the change. Returns "" when nothing usable survives, which leaves
 * the field empty rather than offering a name made of punctuation.
 */
export function suggestBranchName(subject: string): string {
  const described = subject
    .replace(/^\s*\w+(\([^)]*\))?!?:\s*/, "")
    .replace(/\s*\(#\d+\)\s*$/, "");
  return described
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

export type BranchNameProblem =
  | { kind: "empty" }
  | { kind: "taken" }
  | { kind: "malformed"; message: string };

/**
 * Reject what `git branch` would reject, before anything touches the repo.
 * These mirror git-check-ref-format(1)'s rules for the parts a typed name can
 * plausibly break; git itself remains the authority when the command runs.
 */
export function branchNameProblem(
  name: string,
  existing: readonly string[]
): BranchNameProblem | null {
  const trimmed = name.trim();
  if (trimmed === "") return { kind: "empty" };
  if (existing.some((branch) => branch === trimmed)) return { kind: "taken" };

  if (/[\s~^:?*[\\]/.test(trimmed)) {
    return {
      kind: "malformed",
      message: "Branch names can't contain spaces or ~ ^ : ? * [ \\"
    };
  }
  if (trimmed.includes("..") || trimmed.includes("@{")) {
    return { kind: "malformed", message: "Branch names can't contain .. or @{" };
  }
  if (
    trimmed.startsWith("/") ||
    trimmed.endsWith("/") ||
    trimmed.includes("//")
  ) {
    return {
      kind: "malformed",
      message: "Branch names can't start or end with / or contain //"
    };
  }
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) {
    return { kind: "malformed", message: "Branch names can't start or end with ." };
  }
  if (trimmed.endsWith(".lock")) {
    return { kind: "malformed", message: "Branch names can't end with .lock" };
  }
  return null;
}

/**
 * The choice the dialog opens on. The stored preference is what the user picked
 * last time app-wide; when that choice is unavailable right now (an in-place
 * checkout into a dirty worktree) it falls back for this dialog only — the
 * stored value is deliberately left alone so the next clean worktree honours it.
 */
export function initialCheckoutTarget(
  stored: BranchCheckoutTarget,
  canCheckoutHere: boolean
): BranchCheckoutTarget {
  return stored === "here" && !canCheckoutHere ? "new-worktree" : stored;
}

/** The remembered choice, app-wide and shared by every repo. */
export function readStoredCheckoutTarget(): BranchCheckoutTarget {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isBranchCheckoutTarget(raw) ? raw : BRANCH_CHECKOUT_TARGET_DEFAULT;
  } catch {
    return BRANCH_CHECKOUT_TARGET_DEFAULT;
  }
}

export function writeStoredCheckoutTarget(target: BranchCheckoutTarget): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, target);
  } catch {
    // A blocked storage partition costs the memory of the choice, nothing else.
  }
}
