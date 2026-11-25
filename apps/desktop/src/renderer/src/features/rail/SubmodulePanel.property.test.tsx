// @vitest-environment jsdom

import fc from "fast-check";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ok,
  type ChangeSet,
  type SubmoduleCheckoutState,
  type SubmoduleIssue,
  type SubmoduleRelation,
  type SubmoduleSnapshot,
  type SubmoduleStatus,
  type Worktree
} from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn(() => vi.fn())
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe,
  windowProfileId: () => null
}));
vi.mock("../shell/dialogs", () => ({
  confirmDialog: vi.fn(),
  notifyDialog: vi.fn()
}));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));
vi.mock("../../lib/copyText", () => ({ copyText: vi.fn() }));

import { ChangesTab } from "./ChangesTab";
import { SubmodulePanel } from "./SubmodulePanel";

const SHA_A = "1111111111111111111111111111111111111111";
const SHA_B = "2222222222222222222222222222222222222222";
const SHARED_REMEDY =
  "Restore a matching .gitmodules entry with a reviewed URL before initializing, or remove the gitlink if it was added accidentally.";

/**
 * Oracle for what counts as an active local working-tree change on a submodule
 * (matching what requires immediate attention in Changes, as opposed to passive
 * uninitialized/unconfigured/deinitialized repository state where `git status`
 * reports a clean working tree).
 */
function hasActiveLocalChange(submodule: SubmoduleStatus): boolean {
  const stagedPinMoved =
    submodule.indexCommit !== undefined &&
    submodule.indexCommit !== submodule.pinnedCommit;
  const hasConflict = submodule.issues.some(
    (problem) => problem.code === "index_conflict"
  );
  return (
    submodule.dirty === true ||
    stagedPinMoved ||
    hasConflict ||
    (submodule.relation !== "at_pin" && submodule.relation !== "unknown")
  );
}

const submoduleScenarioArb: fc.Arbitrary<SubmoduleStatus> = fc
  .record({
    id: fc.constantFrom("alpha", "beta", "distilled", "floci", "core"),
    nested: fc.boolean(),
    checkoutState: fc.constantFrom<SubmoduleCheckoutState>(
      "checked_out",
      "uninitialized",
      "deinitialized",
      "missing",
      "not_repository"
    ),
    relationWhenCheckedOut: fc.constantFrom<SubmoduleRelation>(
      "at_pin",
      "ahead_of_pin",
      "behind_pin",
      "diverged_from_pin",
      "unknown"
    ),
    dirtyWhenCheckedOut: fc.boolean(),
    stagedPinMoved: fc.boolean(),
    missingGitmodules: fc.boolean(),
    hasConflict: fc.boolean(),
    urlChanged: fc.boolean()
  })
  .map((s) => {
    const path = s.nested
      ? `.repos/alchemy-effect/submodules/${s.id}`
      : `modules/${s.id}`;
    const checkedOut = s.checkoutState === "checked_out";
    const relation: SubmoduleRelation = checkedOut
      ? s.relationWhenCheckedOut
      : "unknown";
    const dirty = checkedOut ? s.dirtyWhenCheckedOut : null;
    const issues: SubmoduleIssue[] = [];
    if (s.missingGitmodules) {
      issues.push({
        code: "gitmodules_entry_missing",
        severity: "error",
        message:
          "The parent records a gitlink here, but .gitmodules has no matching path.",
        remedy: SHARED_REMEDY
      });
    }
    if (s.hasConflict) {
      issues.push({
        code: "index_conflict",
        severity: "error",
        message: "The parent index has an unresolved submodule gitlink conflict.",
        remedy: "Resolve the parent merge before updating the submodule checkout."
      });
    }
    if (s.urlChanged && !s.missingGitmodules) {
      issues.push({
        code: "url_changed",
        severity: "warning",
        message: "The initialized URL differs from the current .gitmodules URL.",
        remedy: "Review the new endpoint, then run submodule sync before fetching."
      });
    }
    if (s.checkoutState === "uninitialized") {
      issues.push({
        code: "checkout_uninitialized",
        severity: "warning",
        message: "This submodule has not been initialized.",
        remedy: s.missingGitmodules
          ? SHARED_REMEDY
          : "Initialize it from the parent after reviewing the configured URL."
      });
    } else if (s.checkoutState === "deinitialized") {
      issues.push({
        code: "checkout_deinitialized",
        severity: "warning",
        message:
          "This submodule was deinitialized; its Git data is still retained locally.",
        remedy: s.missingGitmodules
          ? SHARED_REMEDY
          : "Reinitialize it from the parent after reviewing the configured URL."
      });
    } else if (s.checkoutState === "missing") {
      issues.push({
        code: "checkout_missing",
        severity: "error",
        message: "The submodule checkout path is missing.",
        remedy: s.missingGitmodules
          ? SHARED_REMEDY
          : "Initialize this path from the parent repository after reviewing its URL."
      });
    }
    return {
      name: s.id,
      path,
      depth: 0,
      pinnedCommit: SHA_A,
      indexCommit: s.stagedPinMoved ? SHA_B : SHA_A,
      ...(checkedOut ? { checkedOutCommit: SHA_A } : {}),
      checkoutState: s.checkoutState,
      relation,
      dirty,
      detached: checkedOut ? true : null,
      pinnedTags: [],
      ...(s.missingGitmodules ? {} : { configuredUrl: `../${s.id}.git` }),
      issues
    };
  });

const snapshotArb: fc.Arbitrary<SubmoduleSnapshot> = fc
  .uniqueArray(submoduleScenarioArb, {
    minLength: 1,
    maxLength: 4,
    selector: (row) => row.path
  })
  .map((submodules) => ({
    submodules,
    truncated: false,
    issues: []
  }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.dispatch.mockReset();
  mocks.subscribe.mockImplementation(() => vi.fn());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("SubmodulePanel quiet-by-default properties", () => {
  it("expands by default and flags concern iff a submodule has an active local change", async () => {
    await fc.assert(
      fc.asyncProperty(snapshotArb, async (snapshot) => {
        mocks.dispatch.mockResolvedValue(ok(snapshot));
        const onConcernChange = vi.fn();
        await act(async () => {
          root.render(
            <SubmodulePanel
              worktreeId="wt-prop"
              onConcernChange={onConcernChange}
            />
          );
        });

        const expectActive = snapshot.submodules.some(hasActiveLocalChange);
        const toggle = container.querySelector<HTMLButtonElement>(
          ".submodule-panel__toggle"
        );
        expect(toggle).not.toBeNull();
        expect(toggle?.getAttribute("aria-expanded")).toBe(String(expectActive));
        expect(onConcernChange).toHaveBeenLastCalledWith(expectActive);

        const rowsBeforeClick = container.querySelectorAll(".submodule-row");
        expect(rowsBeforeClick.length).toBe(
          expectActive ? snapshot.submodules.length : 0
        );

        // Expand if collapsed so we can verify row-level properties for every snapshot.
        if (!expectActive) {
          await act(async () => toggle?.click());
        }

        const rows = [
          ...container.querySelectorAll<HTMLDetailsElement>(".submodule-row")
        ];
        expect(rows).toHaveLength(snapshot.submodules.length);

        for (let i = 0; i < snapshot.submodules.length; i++) {
          const submodule = snapshot.submodules[i]!;
          const row = rows[i]!;
          expect(row.open).toBe(hasActiveLocalChange(submodule));

          // Never show the redundant "Unknown relation" chip when not checked out.
          const chips = [...row.querySelectorAll(".submodule-chip")].map(
            (chip) => chip.textContent?.trim()
          );
          if (submodule.checkoutState !== "checked_out") {
            expect(chips).not.toContain("Unknown relation");
          }

          // Never repeat identical remedy copy across stacked alerts in one row.
          const remedies = [...row.querySelectorAll(".submodule-issue small")]
            .map((el) => el.textContent?.trim())
            .filter((text): text is string => text !== undefined && text !== "");
          expect(new Set(remedies).size).toBe(remedies.length);
        }

        await act(async () => root.render(<></>));
      }),
      { numRuns: 45 }
    );
  });

  it("renders ChangesTab working-tree state before the Submodules panel", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (hasChanges) => {
        const changes: ChangeSet = hasChanges
          ? {
              staged: [],
              unstaged: [{ path: "src/app.ts", status: "M", staged: false }]
            }
          : { staged: [], unstaged: [] };
        const passiveSnapshot: SubmoduleSnapshot = {
          truncated: false,
          issues: [],
          submodules: [
            {
              name: ".repos/alchemy-effect/submodules/distilled",
              path: ".repos/alchemy-effect/submodules/distilled",
              depth: 0,
              pinnedCommit: SHA_A,
              indexCommit: SHA_A,
              checkoutState: "uninitialized",
              relation: "unknown",
              dirty: null,
              detached: null,
              pinnedTags: [],
              issues: [
                {
                  code: "gitmodules_entry_missing",
                  severity: "error",
                  message:
                    "The parent records a gitlink here, but .gitmodules has no matching path.",
                  remedy: SHARED_REMEDY
                },
                {
                  code: "checkout_uninitialized",
                  severity: "warning",
                  message: "This submodule has not been initialized.",
                  remedy: SHARED_REMEDY
                }
              ]
            }
          ]
        };

        mocks.dispatch.mockImplementation(async (command: string) => {
          if (command === "changes:list") return ok(changes);
          if (command === "submodules:list") return ok(passiveSnapshot);
          return ok(null);
        });

        await act(async () => {
          root.render(
            <ChangesTab
              worktree={{ id: "worktree-1" } as Worktree}
              activeEmail="dev@example.test"
              onOpenDiff={vi.fn()}
              onOpenFileInsight={vi.fn()}
              activeFile={null}
            />
          );
        });

        const primary = container.querySelector(
          hasChanges ? ".file-row" : ".changes-clean"
        );
        const submodules = container.querySelector(".submodule-panel");
        expect(primary).not.toBeNull();
        expect(submodules).not.toBeNull();
        const order = primary!.compareDocumentPosition(submodules!);
        expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        if (!hasChanges) {
          expect(container.querySelector(".changes-clean__title")?.textContent).toBe(
            "Worktree is clean."
          );
        }

        await act(async () => root.render(<></>));
      }),
      { numRuns: 6 }
    );
  });
});
