/**
 * The wizard's step model, kept apart from the component so the navigation can
 * be tested without rendering anything.
 *
 * Lifted from PwrAgnt's `OnboardingWizard.tsx`: a flat list of surfaces, a
 * separate rail that several surfaces can share, and a `-1` for the screens
 * that come before the rail starts. PwrGit has four rail steps where PwrAgnt
 * has five.
 *
 * Step 3 is not a line (design/New User Journey - UX Review, card 3d). It
 * opens on a choice of three honest answers, and the next surface depends on
 * which was chosen: the search (`repos-find`), the folder picker's list
 * (`repos-pick`), or "I do not have any" (`repos-home`). The scan result
 * follows the first two; a folder just made has nothing to scan.
 */
export type WizardStep =
  | "welcome"
  | "identity"
  | "forges"
  | "repos-choose"
  | "repos-find"
  | "repos-pick"
  | "repos-home"
  | "repos-scan"
  | "done";

/** The answer chosen on `repos-choose` (card 3a). */
export type RepoChoice = "find" | "pick" | "home";

export const CHOICE_STEP: Record<RepoChoice, WizardStep> = {
  find: "repos-find",
  pick: "repos-pick",
  home: "repos-home"
};

export type RailIndex = 0 | 1 | 2 | 3;

export const RAIL_LABELS: readonly string[] = [
  "Identity",
  "Forges",
  "Repositories",
  "Review"
];

/** Which rail step a surface belongs to; -1 for the pre-rail Welcome. */
export function railIndexForStep(step: WizardStep): RailIndex | -1 {
  if (step === "welcome") return -1;
  if (step === "identity") return 0;
  if (step === "forges") return 1;
  if (step === "done") return 3;
  return 2;
}

/** The surface after `step`, given the choice made on `repos-choose`. */
export function nextStep(step: WizardStep, choice: RepoChoice): WizardStep | null {
  switch (step) {
    case "welcome":
      return "identity";
    case "identity":
      return "forges";
    case "forges":
      return "repos-choose";
    case "repos-choose":
      return CHOICE_STEP[choice];
    case "repos-find":
    case "repos-pick":
      return "repos-scan";
    case "repos-home":
    case "repos-scan":
      return "done";
    case "done":
      return null;
  }
}

/** The surface Back returns to: always the one that led here. */
export function previousStep(step: WizardStep, choice: RepoChoice): WizardStep | null {
  switch (step) {
    case "welcome":
      return null;
    case "identity":
      return "welcome";
    case "forges":
      return "identity";
    case "repos-choose":
      return "forges";
    case "repos-find":
    case "repos-pick":
    case "repos-home":
      return "repos-choose";
    case "repos-scan":
      return CHOICE_STEP[choice];
    case "done":
      return choice === "home" ? "repos-home" : "repos-scan";
  }
}

/** What setup left unanswered, in step order: what "Finish setup" names
 *  and where it reopens the wizard (card 4a). Folders are not listed: the
 *  start screen that carries the button is itself about folders. */
export type Unanswered = { step: WizardStep; label: string };

export function unansweredSteps(input: {
  authorName: string | null;
  email: string;
  forgeConnected: boolean | null;
}): Unanswered[] {
  const out: Unanswered[] = [];
  const noName = (input.authorName ?? "").trim() === "";
  const noEmail = input.email.trim() === "";
  if (noName || noEmail) {
    out.push({
      step: "identity",
      label: noName && noEmail ? "no commit author" : noName ? "no author name" : "no author e-mail"
    });
  }
  // Unknown (statuses not read yet) is not "unanswered": say nothing rather
  // than flash a claim the next frame takes back.
  if (input.forgeConnected === false) out.push({ step: "forges", label: "no forge sign-in" });
  return out;
}

/**
 * The rail's label for one step — the step's own name until you are past it,
 * then the answer you gave.
 *
 * This is what lets Done carry no summary table: the rail already is one.
 */
export function railLabel(
  index: number,
  currentIndex: number,
  answers: {
    authorName: string | null;
    forgeSummary: string | null;
    roots: readonly string[];
  }
): string {
  const past = currentIndex > index;
  if (index === 0 && past && answers.authorName !== null)
    return answers.authorName;
  if (index === 1 && past && answers.forgeSummary !== null)
    return answers.forgeSummary;
  if (index === 2 && past) {
    if (answers.roots.length === 0) return "None";
    const [first, ...rest] = answers.roots;
    return rest.length === 0 ? first! : `${first!} +${rest.length}`;
  }
  return RAIL_LABELS[index] ?? "";
}
