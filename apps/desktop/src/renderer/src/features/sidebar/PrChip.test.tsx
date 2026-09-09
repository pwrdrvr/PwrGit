// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwrgit/shared";

vi.mock("../../lib/pwrgit", () => ({ dispatch: vi.fn() }));

import { PrChip } from "./PrChip";

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 121,
    url: "https://github.com/pwrdrvr/PwrGit/pull/121",
    title: "Read merge request status from GitLab",
    state: "open",
    isDraft: false,
    ...overrides
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Focus opens the card at once, bypassing the pointer's dwell gate. */
function openCard(summary: PrSummary): HTMLElement | null {
  act(() => root.render(<PrChip pr={summary} />));
  const chip = container.querySelector<HTMLElement>(".pr-chip");
  if (chip === null) throw new Error("chip did not render");
  act(() => chip.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  return document.body.querySelector<HTMLElement>("[role='dialog']");
}

describe("PrChip hover card", () => {
  it("announces itself as the thing it is showing", () => {
    // The card shares its hook with the commit-context card, which used to
    // lend it its own name — a screen reader heard "Commit context" while
    // reading a pull request.
    expect(openCard(pr({ forge: "github" }))?.getAttribute("aria-label")).toBe(
      "Pull request"
    );
  });

  it("uses GitLab's word for a GitLab change request", () => {
    expect(openCard(pr({ forge: "gitlab" }))?.getAttribute("aria-label")).toBe(
      "Merge request"
    );
  });

  it("falls back to the app's neutral term for an unstamped row", () => {
    expect(openCard(pr())?.getAttribute("aria-label")).toBe("Pull request");
  });
});


describe("PR check presentation", () => {
  it.each([
    [{ checkState: "passing", isDraft: true }, "passing", "draft · checks passing"],
    [{ checkState: "pending" }, "pending", "checks pending"],
    [{ checkState: "failing", checksStillRunning: true }, "failing", "checks failing · checks still running"],
    [{ checkState: "passing", mergeState: "conflicting" }, "conflicting", "merge conflict · checks passing"],
    [{ state: "merged", isDraft: true, checkState: "failing", mergeState: "conflicting" }, "merged", "merged"],
    [{ state: "closed", checkState: "passing" }, "closed", "closed without merge"],
    [{}, "unknown", "status unknown"]
  ] as const)("keeps the chip and card aligned for %j", (overrides, dot, label) => {
    const card = openCard(pr(overrides));
    const chip = container.querySelector(".pr-chip")!;
    expect(chip.classList.contains(`pr-chip--${dot}`)).toBe(true);
    expect(chip.getAttribute("aria-label")).toContain(label);
    expect(card?.textContent).toContain(label);
    expect(card?.querySelector(`.pr-status-card__dot--${dot}`)).not.toBeNull();
    expect(chip.classList.contains("pr-chip--checks-running")).toBe(
      "checksStillRunning" in overrides && overrides.checksStillRunning === true
    );
    expect(chip.querySelector(".pr-chip__draft-bar") !== null).toBe(
      "isDraft" in overrides && overrides.isDraft === true && !("state" in overrides)
    );
  });

  it("updates an already-open card when checks finish", () => {
    openCard(pr({ checkState: "pending" }));
    act(() => root.render(<PrChip pr={pr({ checkState: "passing" })} />));
    expect(document.body.querySelector("[role='dialog']")?.textContent).toContain("checks passing");
    expect(container.querySelector(".pr-chip--passing")).not.toBeNull();
  });
});
