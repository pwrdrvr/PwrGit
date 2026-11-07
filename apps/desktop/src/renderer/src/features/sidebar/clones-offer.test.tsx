// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type ClonesOffer } from "@pwrgit/shared";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch,
  subscribe: () => () => undefined,
  windowProfileId: () => "one"
}));

import { ToastHost } from "../shell/ToastHost";
import { dismissToast, subscribeToasts, type Toast } from "../../lib/toast";
import { clonesOfferCopy, useClonesOffer } from "./clones-offer";

const GIB = 1024 * 1024 * 1024;

describe("the offer's words", () => {
  it("names Git's projection, 'at least' when partly measured, and files when unmeasured", () => {
    expect(clonesOfferCopy({ kind: "bytes", bytes: 6.32 * GIB, atLeast: false }).message)
      .toMatch(/^Your worktrees could save about 6\.32 GiB \(projected\) by sharing unchanged files/);
    expect(clonesOfferCopy({ kind: "bytes", bytes: 2.1 * GIB, atLeast: true }).message)
      .toMatch(/could save at least 2\.10 GiB \(projected\)/);
    const files = clonesOfferCopy({ kind: "files", files: 3412 }).message;
    expect(files).toMatch(/^3,412 unchanged files in your worktrees/);
    expect(files).not.toMatch(/\d B|iB/);
  });
  it("always says it is compatible, and never 'freed'", () => {
    for (const offer of [{ kind: "bytes", bytes: GIB, atLeast: false }, { kind: "files", files: 900 }] as ClonesOffer[]) {
      const { title, message } = clonesOfferCopy(offer);
      expect(title).toBe("Save disk space");
      expect(message).toContain("Fully compatible with Git and every other tool");
      expect(`${title} ${message}`).not.toMatch(/free/i);
    }
  });
});

let container: HTMLDivElement;
let root: Root;
let accepted: ReturnType<typeof vi.fn<() => void>>;
function Probe() {
  useClonesOffer("one", () => accepted(), 0);
  return <ToastHost repos={[]} onReveal={() => undefined} />;
}
const answers = () => dispatch.mock.calls.filter(([name]) => name === "maintenance:clonesOfferAnswer").map(([, req]) => req);

beforeEach(async () => {
  let current: Toast[] = [];
  subscribeToasts((next) => { current = next; })();
  for (const toast of [...current]) dismissToast(toast.id);
  accepted = vi.fn();
  dispatch.mockImplementation(async (name: string) =>
    ok(name === "maintenance:clonesOffer" ? ({ kind: "bytes", bytes: 3 * GIB, atLeast: false } satisfies ClonesOffer)
      : name === "remote:activities" ? [] : { status: "idle" }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("the offer's toast", () => {
  it("stands until answered, and Share files records the answer and opens the run", async () => {
    const card = container.querySelector(".app-toast")!;
    expect(card.textContent).toContain("Save disk space");
    expect(container.querySelector(".app-toast__timer")).toBeNull();
    const share = [...card.querySelectorAll("button")].find((node) => node.textContent === "Share files")!;
    await act(async () => share.click());
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(answers()).toEqual([{ profileId: "one", answer: "accepted" }]);
    expect(container.querySelector(".app-toast")).toBeNull();
  });
  it("× records a dismissal and opens nothing", async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click());
    expect(accepted).not.toHaveBeenCalled();
    expect(answers()).toEqual([{ profileId: "one", answer: "dismissed" }]);
    expect(container.querySelector(".app-toast")).toBeNull();
  });
});
