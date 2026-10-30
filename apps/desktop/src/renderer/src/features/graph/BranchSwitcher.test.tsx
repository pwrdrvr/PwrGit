// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchRef, RetrackReview, TrackingChoices, TrackingOption } from "@pwrgit/shared";

const bridge = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({ dispatch: bridge.dispatch }));
vi.mock("../../lib/toast", () => ({ showInfoToast: vi.fn() }));
vi.mock("../shell/branchSwitch", () => ({
  guardedSwitchBranch: vi.fn(() => Promise.resolve({ kind: "switched" }))
}));

import { showInfoToast } from "../../lib/toast";
import { guardedSwitchBranch } from "../shell/branchSwitch";
import { BranchSwitcher } from "./BranchSwitcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = <T,>(value: T) => ({ ok: true as const, value });
const head = (c: string) => c.repeat(40);

// The disktree report: main tracks origin; pwrdisk's main is two ahead.
const branches: BranchRef[] = [
  { name: "main", isRemote: false, isCurrent: true, upstream: "origin/main" },
  { name: "fix/mark", isRemote: false, isCurrent: false },
  { name: "origin/main", isRemote: true, isCurrent: false, remote: "origin", remoteBranch: "main" },
  { name: "pwrdisk/main", isRemote: true, isCurrent: false, remote: "pwrdisk", remoteBranch: "main" },
  { name: "upstream/main", isRemote: true, isCurrent: false, remote: "upstream", remoteBranch: "main" }
];
const option = (remote: string, over: Partial<TrackingOption> = {}): TrackingOption => ({
  remote,
  remoteBranch: "main",
  ref: `${remote}/main`,
  head: head("1"),
  ahead: 0,
  behind: 0,
  tracked: false,
  ...over
});
const choices: TrackingChoices = {
  branch: "main",
  head: head("1"),
  upstream: "origin/main",
  options: [
    option("origin", { tracked: true, nameWithOwner: "huntharo/disktree", canPush: true }),
    option("pwrdisk", { head: head("2"), behind: 2, nameWithOwner: "pwrdrvr/PwrDisk" }),
    option("upstream", { nameWithOwner: "tobi/disktree" })
  ]
};
const review: RetrackReview = {
  branch: "main",
  head: head("1"),
  upstreamRef: "refs/remotes/origin/main",
  from: choices.options[0] ?? null,
  target: choices.options[1] as TrackingOption,
  unpushed: 0,
  leavingOn: null,
  arriving: [
    { hash: head("2"), subject: "pwrdisk two" },
    { hash: head("3"), subject: "pwrdisk one" }
  ],
  checkout: { kind: "here", dirty: 0 },
  pushOverride: null,
  copyName: "main-before-pwrdisk"
};

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  bridge.dispatch.mockImplementation((name: string) => {
    if (name === "branch:list") return Promise.resolve(ok(branches));
    if (name === "remote:trackingOptions") return Promise.resolve(ok(choices));
    if (name === "remote:inspectRetrack") return Promise.resolve(ok(review));
    if (name === "remote:retrack") return Promise.resolve(ok({ moved: true, copied: null }));
    return new Promise(() => undefined);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => Promise.resolve());
};
const mount = async () => {
  await act(async () => {
    root.render(
      <BranchSwitcher
        worktreeId="wt-1"
        worktreeLabel="disktree"
        currentBranch="main"
        onHeldElsewhere={vi.fn()}
        onClose={onClose}
      />
    );
  });
  await flush();
};
const input = () => container.querySelector<HTMLInputElement>(".overlay-search input");
const rowNames = () =>
  [...container.querySelectorAll(".overlay-results [role='option'] .branch-item__name")].map(
    (el) => el.firstChild?.textContent
  );
const key = async (k: string) => {
  await act(async () => {
    input()?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
  await flush();
};
const type = async (text: string) => {
  const el = input();
  if (el === null) throw new Error("no input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};

describe("BranchSwitcher", () => {
  it("finds another remote's main through the local row's chip", async () => {
    await mount();
    expect(rowNames()).toEqual(["main", "fix/mark"]);
    await type("pwrdisk/main");
    expect(rowNames()).toEqual(["main"]);
    const chip = container.querySelector(".branch-track");
    expect(chip?.classList.contains("is-changed")).toBe(true);
    expect(chip?.textContent).toBe("track pwrdisk/main");
    expect(container.querySelector(".branch-track__hint")?.textContent).toBe("↓2");
    expect(container.querySelector(".overlay-foot")?.textContent).toContain("↵ review tracking change");
  });

  it("opens the remote menu from the keyboard, with each remote's relation", async () => {
    await mount();
    await key("ArrowRight");
    const items = [...document.querySelectorAll(".branch-track-menu__item")];
    expect(items.map((el) => el.querySelector(".branch-track-menu__rel")?.textContent)).toEqual([
      "same commit",
      "↓2 fast-forward",
      "same commit"
    ]);
    expect(items[0]?.querySelector(".branch-track-menu__check svg")).not.toBeNull();
    await key("ArrowDown");
    await key("Enter");
    // Picking a remote opens the review; nothing has changed yet.
    expect(bridge.dispatch).toHaveBeenCalledWith("remote:inspectRetrack", {
      worktreeId: "wt-1",
      branch: "main",
      remote: "pwrdisk",
      remoteBranch: "main"
    });
    expect(bridge.dispatch).not.toHaveBeenCalledWith("remote:retrack", expect.anything());
    expect(container.querySelector(".retrack__title")?.textContent).toBe("Track pwrdisk/main for main");
  });

  it("confirms a fast-forward in the review, then closes with a receipt", async () => {
    await mount();
    await type("pwrdisk/main");
    await key("Enter");
    const cta = container.querySelector<HTMLButtonElement>(".retrack__foot .modal__create");
    expect(cta?.textContent).toBe("Track and fast-forward");
    expect(container.querySelector(".retrack__cmd")?.textContent).toBe(
      "git merge --ff-only 2222222 · git branch --set-upstream-to=pwrdisk/main main"
    );
    await act(async () => cta?.click());
    await flush();
    expect(bridge.dispatch).toHaveBeenCalledWith("remote:retrack", {
      worktreeId: "wt-1",
      branch: "main",
      remote: "pwrdisk",
      remoteBranch: "main",
      head: head("1"),
      targetHead: head("2"),
      upstreamRef: "refs/remotes/origin/main",
      move: "forward"
    });
    expect(showInfoToast).toHaveBeenCalledWith({
      title: "main tracks pwrdisk/main",
      message: "Fast-forwarded 2 commits."
    });
    expect(onClose).toHaveBeenCalled();
    // Already checked out here: no switch.
    expect(guardedSwitchBranch).not.toHaveBeenCalled();
  });

  it("goes back to the list from the review without changing anything", async () => {
    await mount();
    await type("pwrdisk/main");
    await key("Enter");
    await act(async () => container.querySelector<HTMLButtonElement>(".retrack__back")?.click());
    await flush();
    expect(rowNames()).toEqual(["main"]);
    expect(bridge.dispatch).not.toHaveBeenCalledWith("remote:retrack", expect.anything());
  });

  it("takes focus into the review, so Esc goes back to the list", async () => {
    await mount();
    await type("pwrdisk/main");
    await key("Enter");
    const panel = container.querySelector<HTMLElement>(".overlay-panel.retrack");
    expect(document.activeElement).toBe(panel);
    await act(async () => {
      panel?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(container.querySelector(".retrack")).toBeNull();
    expect(rowNames()).toEqual(["main"]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("still switches a plain row", async () => {
    await mount();
    await key("ArrowDown");
    await key("Enter");
    expect(guardedSwitchBranch).toHaveBeenCalledWith(expect.objectContaining({ branch: "fix/mark" }));
  });
});
