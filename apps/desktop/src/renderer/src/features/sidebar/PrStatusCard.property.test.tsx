// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSUMED_FORGE_KIND,
  FORGE_KINDS,
  changeRequestLabel,
  changeRequestSigil,
  type PrSummary
} from "@pwrgit/shared";

const { dispatch, copyText } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  copyText: vi.fn()
}));
vi.mock("../../lib/pwrgit", () => ({ dispatch }));
vi.mock("../../lib/copyText", () => ({ copyText }));

import { prPresentation } from "./pr-status";
import { PrStatusCard } from "./PrStatusCard";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  dispatch.mockReset();
  copyText.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const prArb: fc.Arbitrary<PrSummary> = fc.record({
  number: fc.oneof(
    fc.integer({ min: 1, max: 9 }),
    fc.integer({ min: 10, max: 999_999 }),
    fc.integer({ min: 1_000_000, max: 999_999_999 })
  ),
  url: fc.integer({ min: 1, max: 999_999 }).map(
    (n) => `https://forge.example.test/org/repo/pull/${n}`
  ),
  title: fc.oneof(
    fc.constant(""),
    fc.constant("   "),
    fc.string({ minLength: 1, maxLength: 80 })
  ),
  state: fc.constantFrom("open", "merged", "closed"),
  isDraft: fc.boolean(),
  checkState: fc.constantFrom(undefined, "passing", "failing", "pending", "unknown"),
  mergeState: fc.constantFrom(undefined, "mergeable", "conflicting", "unknown"),
  forge: fc.constantFrom(undefined, ...FORGE_KINDS),
  repoPath: fc.oneof(
    fc.constant(undefined),
    fc.constant(""),
    fc.constant("   "),
    fc.constant("o/r"),
    fc.constant("northstar/qa/forge/nested/service-gateway")
  )
}).map((raw) => ({
  number: raw.number,
  url: raw.url,
  title: raw.title,
  state: raw.state,
  isDraft: raw.isDraft,
  ...(raw.checkState === undefined ? {} : { checkState: raw.checkState }),
  ...(raw.mergeState === undefined ? {} : { mergeState: raw.mergeState }),
  ...(raw.forge === undefined ? {} : { forge: raw.forge }),
  ...(raw.repoPath === undefined ? {} : { repoPath: raw.repoPath })
}));

describe("PrStatusCard properties", () => {
  it("always renders the PR number in its own chip with the forge's sigil and matching status dot", () => {
    fc.assert(
      fc.property(prArb, (summary) => {
        act(() => root.render(<PrStatusCard pr={summary} />));

        const forge = summary.forge ?? ASSUMED_FORGE_KIND;
        const expectedNumber = `${changeRequestSigil(forge)}${summary.number}`;
        const expectedEyebrow = changeRequestLabel(forge);
        const expectedDot = prPresentation(summary).dot;

        const eyebrow = container.querySelector(".pr-status-card__eyebrow");
        const chip = container.querySelector<HTMLButtonElement>(".pr-status-card__number-chip");
        const chipText = chip?.querySelector(".pr-status-card__number-text");
        const chipDot = chip?.querySelector(`.pr-status-card__dot--${expectedDot}`);
        const statusDot = container.querySelector(`.pr-status-card__status .pr-status-card__dot--${expectedDot}`);
        const repo = container.querySelector(".pr-status-card__repo");

        expect(eyebrow?.textContent).toBe(expectedEyebrow);
        expect(chip).not.toBeNull();
        expect(chipText?.textContent).toBe(expectedNumber);
        expect(chip?.getAttribute("aria-label")).toBe(
          `Open ${expectedEyebrow.toLowerCase()} ${expectedNumber} in browser`
        );
        expect(chipDot).not.toBeNull();
        expect(statusDot).not.toBeNull();

        const trimmedRepo = summary.repoPath?.trim() ?? "";
        if (trimmedRepo === "") {
          expect(repo).toBeNull();
        } else {
          expect(repo?.textContent).toBe(trimmedRepo);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("opens the PR URL on click and copies the PR URL on Option-click", () => {
    const summary: PrSummary = {
      number: 4524,
      url: "https://github.com/northstar/Beacon/pull/4524",
      title: "Re-clamp popover placement",
      state: "merged",
      isDraft: false,
      forge: "github",
      repoPath: "northstar/Beacon"
    };
    act(() => root.render(<PrStatusCard pr={summary} />));
    const chip = container.querySelector<HTMLButtonElement>(".pr-status-card__number-chip")!;

    act(() => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: false }));
    });
    expect(dispatch).toHaveBeenCalledWith("shell:openExternal", { url: summary.url });
    expect(copyText).not.toHaveBeenCalled();

    dispatch.mockReset();
    act(() => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    });
    expect(copyText).toHaveBeenCalledWith(summary.url);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
