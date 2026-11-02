// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwrgit/shared";
import {
  HOVER_INTENT_DWELL_MS,
  HOVER_INTENT_WARM_DWELL_MS,
  HoverIntentGate,
  hoverIntentHandlers,
  useHoverIntent
} from "../../lib/hoverIntent";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

vi.mock("../../lib/pwrgit", () => ({ dispatch: vi.fn() }));

import { PrChip } from "./PrChip";

/**
 * The PR chip's card is interactive, so the pointer has to be able to leave
 * the chip for it. It used to close on the chip's first `mouseleave`, so the
 * pointer never got there. See "Interactive cards must be reachable" in
 * `lib/AGENTS.md`; the "Why?" card's version is
 * `lib/useViewportTooltipInteractive.test.tsx`.
 *
 * Each chip owns its card, so a card that waits on leave could leave a trail
 * of them down a column of chips. The tests at the bottom hold that to one.
 */

const GRACE_MS = 400;
/** A cold dwell, plus a poll tick or two. */
const DWELL_MS = HOVER_INTENT_DWELL_MS + 100;
/** The next chip's dwell while a card is still up: well inside the grace. */
const WARM_DWELL_MS = HOVER_INTENT_WARM_DWELL_MS + 60;

let cleanup: (() => Promise<void>) | undefined;
let gate: HoverIntentGate;

beforeEach(() => {
  vi.useFakeTimers();
  // A gate per test: the shared one carries warmth from test to test.
  gate = new HoverIntentGate();
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
});

const pr = (number: number): PrSummary => ({
  number,
  url: `https://github.com/pwrdrvr/PwrGit/pull/${number}`,
  title: `Pull request ${number}`,
  state: "open",
  isDraft: false,
  forge: "github"
});

/** A column of chips sharing one gate, as `LineageGraph` passes its rows. */
function Column({ numbers }: { numbers: number[] }) {
  const intent = useHoverIntent(gate);
  return (
    <>
      {numbers.map((n) => (
        <PrChip key={n} pr={pr(n)} hoverIntent={intent} />
      ))}
      <button id="elsewhere">Elsewhere</button>
    </>
  );
}

const mount = async (numbers: number[] = [1]): Promise<HTMLElement[]> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Column numbers={numbers} />));
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return [...container.querySelectorAll<HTMLElement>(".pr-chip")];
};

const cards = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[role="dialog"]')
];
const cardFor = (n: number): HTMLElement | undefined =>
  cards().find((card) => card.textContent?.includes(`Pull request ${n}`));
const elsewhere = (): HTMLElement =>
  document.querySelector<HTMLElement>("#elsewhere")!;

/** The pointer leaves `from` for `to`. React derives both `onMouseLeave` on
 *  `from` and `onMouseEnter` on `to` from this one native event. */
const move = async (from: HTMLElement, to: HTMLElement | null): Promise<void> => {
  await act(async () => {
    from.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: to })
    );
  });
};

const enter = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
};

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

/** Hover `chip` and hold the pointer still until its card opens. */
const dwellOn = async (chip: HTMLElement): Promise<void> => {
  await enter(chip);
  await advance(DWELL_MS);
};

it("keeps the card while the pointer crosses from the chip onto it", async () => {
  const [chip] = await mount();
  await dwellOn(chip!);
  expect(cardFor(1)).toBeDefined();

  // In the gap, the pointer is over neither the chip nor the card.
  await move(chip!, document.body);
  expect(cardFor(1)).toBeDefined();

  // It arrives, and the card stays for as long as the pointer is on it.
  await move(document.body, cardFor(1)!);
  await advance(GRACE_MS * 5);
  expect(cardFor(1)).toBeDefined();

  // Leaving the card takes it away after the same grace.
  await move(cardFor(1)!, elsewhere());
  expect(cardFor(1)).toBeDefined();
  await advance(GRACE_MS);
  expect(cardFor(1)).toBeUndefined();
});

it("keeps the card when the pointer goes straight onto it", async () => {
  // The bridge makes the card start at the chip's edge, so this is the usual
  // path: no gap at all, and the card's own `mouseleave` decides from here.
  const [chip] = await mount();
  await dwellOn(chip!);
  await move(chip!, cardFor(1)!);
  await advance(GRACE_MS * 5);
  expect(cardFor(1)).toBeDefined();
});

it("closes the card after the grace when the pointer goes anywhere else", async () => {
  const [chip] = await mount();
  await dwellOn(chip!);
  await move(chip!, elsewhere());
  await advance(GRACE_MS - 1);
  expect(cardFor(1)).toBeDefined();
  await advance(1);
  expect(cardFor(1)).toBeUndefined();
});

it("still takes the card with it at once on a click", async () => {
  // A click opens the PR in the browser; the card has nothing left to say.
  const [chip] = await mount();
  await dwellOn(chip!);
  await act(async () => chip!.click());
  expect(cardFor(1)).toBeUndefined();
});

it("measures the browsing window from when the card closed, not from the leave", async () => {
  // The card outlives the hover that opened it. Reading it for a while must
  // not let the gate go cold, or the next chip waits the full cold dwell.
  const [chip] = await mount();
  await dwellOn(chip!);
  await move(chip!, cardFor(1)!);
  await advance(5_000);
  await move(cardFor(1)!, elsewhere());
  await advance(GRACE_MS);
  expect(cardFor(1)).toBeUndefined();
  expect(gate.isWarm(Date.now())).toBe(true);
});

it("shows one card, not two, when browsing from chip to chip", async () => {
  const [a, b] = await mount([1, 2]);
  await dwellOn(a!);
  expect(cardFor(1)).toBeDefined();

  // Card 1 is still in its grace when chip 2's warm dwell opens card 2. It
  // goes then, instead of sitting beside the new one until its timer runs out.
  await move(a!, b!);
  await advance(WARM_DWELL_MS);
  expect(cardFor(2)).toBeDefined();
  expect(cards()).toHaveLength(1);
});

it("closes a card left from its own card when the next chip opens", async () => {
  const [a, b] = await mount([1, 2]);
  await dwellOn(a!);
  await move(a!, cardFor(1)!);
  // Off the card and onto the next chip: card 1 starts its grace.
  await move(cardFor(1)!, b!);
  await advance(WARM_DWELL_MS);
  expect(cardFor(2)).toBeDefined();
  expect(cards()).toHaveLength(1);
});

it("leaves no trail of cards when the pointer sweeps down the chips", async () => {
  const chips = await mount([1, 2, 3, 4, 5, 6]);
  // Start from an open card: the hardest case, since that one is entitled to
  // its grace.
  await dwellOn(chips[0]!);
  expect(cards()).toHaveLength(1);

  // A sweep: 30px every 10ms, about 40ms on each chip.
  let y = 0;
  let maxOpen = 0;
  for (let i = 0; i < chips.length; i += 1) {
    if (i > 0) await move(chips[i - 1]!, chips[i]!);
    for (let step = 0; step < 4; step += 1) {
      y += 30;
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: y }));
      });
      await advance(10);
      maxOpen = Math.max(maxOpen, cards().length);
    }
  }
  await move(chips.at(-1)!, elsewhere());
  await advance(GRACE_MS);

  expect(maxOpen).toBeLessThanOrEqual(1);
  expect(cards()).toHaveLength(0);
});

/** A commit card wired as `LineageGraph` wires its rows' SHA chips: one
 *  card, `scheduleHide` as the leave, and a `PrChip` inside it, as
 *  `CommitContextCard` draws one. */
function CommitWithPr() {
  const intent = useHoverIntent(gate);
  const commit = useViewportTooltip("commit-context-card", {
    interactive: true,
    label: "Commit context"
  });
  const sha = hoverIntentHandlers({
    intent,
    show: (target) =>
      commit.show(
        target,
        <div id="commit-card">
          {/* `CommitContextCard` passes no gate, so its chip falls back to the
              window's, which is `LineageGraph`'s too. Same gate here. */}
          <PrChip pr={pr(7)} hoverIntent={intent} />
        </div>
      ),
    hide: commit.scheduleHide
  });
  return (
    <>
      <button
        id="sha"
        onMouseEnter={(e) => sha.onMouseEnter(e.currentTarget)}
        onMouseLeave={sha.onMouseLeave}
      >
        abc1234
      </button>
      {commit.tooltipNode}
    </>
  );
}

it("opens a PR card inside the commit card without closing the commit card", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<CommitWithPr />));
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const sha = container.querySelector<HTMLElement>("#sha")!;
  const commitCard = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[aria-label="Commit context"]');

  await dwellOn(sha);
  expect(commitCard()).not.toBeNull();
  await move(sha, commitCard()!);

  // Onto the PR chip in the commit card, and from there onto its own card.
  const chip = commitCard()!.querySelector<HTMLElement>(".pr-chip")!;
  await move(commitCard()!, chip);
  await advance(DWELL_MS);
  expect(cardFor(7)).toBeDefined();
  await move(chip, cardFor(7)!);
  await advance(GRACE_MS * 5);

  // Closing the commit card would unmount the chip, and the PR card with it.
  expect(commitCard()).not.toBeNull();
  expect(cardFor(7)).toBeDefined();
});
