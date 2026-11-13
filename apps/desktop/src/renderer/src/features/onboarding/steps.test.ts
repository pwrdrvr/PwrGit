import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHOICE_STEP,
  nextStep,
  previousStep,
  railIndexForStep,
  railLabel,
  unansweredSteps,
  type RepoChoice,
  type WizardStep
} from "./steps";

const NO_ANSWERS = {
  authorName: null,
  forgeSummary: null,
  roots: [] as readonly string[]
};

const choiceArb = fc.constantFrom<RepoChoice>("find", "pick", "home");

/** The path a choice takes, Welcome to Done. */
function path(choice: RepoChoice): WizardStep[] {
  const steps: WizardStep[] = ["welcome"];
  let cursor: WizardStep | null = "welcome";
  while ((cursor = nextStep(cursor, choice)) !== null) {
    if (steps.includes(cursor)) throw new Error(`loop at ${cursor}`);
    steps.push(cursor);
  }
  return steps;
}

// Card 3d: step 3 opens on a choice, and each answer goes somewhere.
describe("the step model", () => {
  it("reaches Done from Welcome on every choice, through that choice's own surface", () => {
    fc.assert(
      fc.property(choiceArb, (choice) => {
        const steps = path(choice);
        expect(steps.at(-1)).toBe("done");
        expect(steps).toContain("repos-choose");
        expect(steps).toContain(CHOICE_STEP[choice]);
        // Never another choice's surface.
        for (const other of ["find", "pick", "home"] as RepoChoice[]) {
          if (other !== choice) expect(steps).not.toContain(CHOICE_STEP[other]);
        }
      })
    );
  });

  it("Back retraces the path exactly", () => {
    fc.assert(
      fc.property(choiceArb, (choice) => {
        const steps = path(choice);
        for (let i = 1; i < steps.length; i += 1) {
          expect(previousStep(steps[i]!, choice)).toBe(steps[i - 1]);
        }
        expect(previousStep("welcome", choice)).toBeNull();
      })
    );
  });

  it("keeps Welcome off the rail, and every repository surface on step 3", () => {
    expect(railIndexForStep("welcome")).toBe(-1);
    for (const step of ["repos-choose", "repos-find", "repos-pick", "repos-home", "repos-scan"] as const) {
      expect(railIndexForStep(step)).toBe(2);
    }
    expect(railIndexForStep("done")).toBe(3);
  });

  it("the scan result follows only an answer that added folders to scan", () => {
    expect(path("find")).toContain("repos-scan");
    expect(path("pick")).toContain("repos-scan");
    // A folder just made, or just picked as "where they will live", has
    // nothing in it worth a scan step.
    expect(path("home")).not.toContain("repos-scan");
  });
});

// Card 4a: Finish setup shows only when something is unanswered, names it,
// and reopens the wizard at the first unanswered step.
describe("unansweredSteps", () => {
  const value = fc.option(fc.constantFrom("", " ", "Dana"), { nil: null });
  const input = fc.record({
    authorName: value,
    email: fc.constantFrom("", "  ", "dana@example.com"),
    forgeConnected: fc.option(fc.boolean(), { nil: null }),
    // null: Git not asked yet.
    gitIdentity: fc.option(fc.record({ name: value, email: value }), { nil: null })
  });
  const has = (v: string | null): boolean => (v ?? "").trim() !== "";

  it("is empty exactly when the commit identity is complete and a forge is (or may be) connected", () => {
    fc.assert(
      fc.property(input, (i) => {
        // What a commit records: the profile's value, else Git's own. Before
        // Git has answered, identity is not claimed missing.
        const filled =
          i.gitIdentity === null ||
          ((has(i.authorName) || has(i.gitIdentity.name)) &&
            (has(i.email) || has(i.gitIdentity.email)));
        const out = unansweredSteps(i);
        expect(out.length === 0).toBe(filled && i.forgeConnected !== false);
      })
    );
  });

  it("lists steps in wizard order, so the first is where Finish setup reopens", () => {
    fc.assert(
      fc.property(input, (i) => {
        const order = unansweredSteps(i).map((u) => railIndexForStep(u.step));
        expect([...order].sort()).toEqual(order);
      })
    );
  });
});

/** The rail is the review surface — this is what lets Done carry no summary. */
describe("railLabel", () => {
  it("shows the step's own name until you are past it", () => {
    expect(railLabel(0, 0, { ...NO_ANSWERS, authorName: "Dana" })).toBe(
      "Identity"
    );
    expect(railLabel(0, 1, { ...NO_ANSWERS, authorName: "Dana" })).toBe("Dana");
  });

  it("falls back to the step name when the answer is empty", () => {
    expect(railLabel(0, 3, NO_ANSWERS)).toBe("Identity");
  });

  it("calls step 3 Repositories, and summarises its folders as first +n", () => {
    expect(railLabel(2, 2, NO_ANSWERS)).toBe("Repositories");
    expect(railLabel(2, 3, { ...NO_ANSWERS, roots: ["~/code"] })).toBe("~/code");
    expect(
      railLabel(2, 3, { ...NO_ANSWERS, roots: ["~/code", "~/work", "~/x"] })
    ).toBe("~/code +2");
    expect(railLabel(2, 3, { ...NO_ANSWERS, roots: [] })).toBe("None");
  });

  it("never relabels Review", () => {
    expect(railLabel(3, 3, { ...NO_ANSWERS, authorName: "Dana" })).toBe(
      "Review"
    );
  });
});
