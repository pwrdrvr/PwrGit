/**
 * The wizard's step model, kept apart from the component so the navigation can
 * be tested without rendering anything.
 *
 * Lifted from PwrAgnt's `OnboardingWizard.tsx`: a flat list of surfaces, a
 * separate rail that several surfaces can share, and a `-1` for the screens
 * that come before the rail starts. PwrGit has four rail steps where PwrAgnt
 * has five.
 */
export type WizardStep =
  | "welcome"
  | "identity"
  | "forges"
  | "folders-explain"
  | "folders-pick"
  | "folders-scan"
  | "done";

export const STEP_ORDER: readonly WizardStep[] = [
  "welcome",
  "identity",
  "forges",
  "folders-explain",
  "folders-pick",
  "folders-scan",
  "done"
];

export type RailIndex = 0 | 1 | 2 | 3;

export const RAIL_LABELS: readonly string[] = [
  "Identity",
  "Forges",
  "Repo folders",
  "Review"
];

/** Which rail step a surface belongs to; -1 for the pre-rail Welcome. */
export function railIndexForStep(step: WizardStep): RailIndex | -1 {
  if (step === "welcome") return -1;
  if (step === "identity") return 0;
  if (step === "forges") return 1;
  if (
    step === "folders-explain" ||
    step === "folders-pick" ||
    step === "folders-scan"
  )
    return 2;
  return 3;
}

export function nextStep(step: WizardStep): WizardStep | null {
  const i = STEP_ORDER.indexOf(step);
  return i < 0 || i === STEP_ORDER.length - 1 ? null : STEP_ORDER[i + 1]!;
}

export function previousStep(step: WizardStep): WizardStep | null {
  const i = STEP_ORDER.indexOf(step);
  return i <= 0 ? null : STEP_ORDER[i - 1]!;
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
