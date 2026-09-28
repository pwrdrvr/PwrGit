// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type Profile } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: () => () => undefined
}));
import { CloneRepoDialog } from "./CloneRepoDialog";
import { ForkRepoDialog } from "./ForkRepoDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const profile: Profile = {
  id: "p",
  name: "Test",
  email: "test@example.com",
  mono: "T",
  roots: [],
  onboardingCompleted: true
};

let container: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;

beforeEach(() => {
  Object.defineProperty(window, "pwrgit", { configurable: true, value: { platform: "linux" } });
  dispatchMock.mockImplementation((channel: string) => {
    if (channel === "repo:cloneCatalog") return Promise.resolve(ok({ owners: [], forges: [] }));
    if (channel === "forge:hosts") return Promise.resolve(ok({ hosts: [], overrides: {} }));
    return Promise.resolve(ok([]));
  });
  opener = document.createElement("button");
  opener.textContent = "Clone…";
  document.body.append(opener);
  opener.focus();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  opener.remove();
  vi.resetAllMocks();
});

function press(target: Element, key: string, shiftKey = false): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })
    );
  });
}

const dialog = (): HTMLElement => container.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (name: string): HTMLButtonElement =>
  [...dialog().querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name
  )!;

// Clone and Fork share the `.clone-dialog` shell, and before useModal both let
// Tab walk off the footer into the window behind them (SC 2.4.3).
describe.each([
  {
    title: "CloneRepoDialog",
    sourceId: "clone-source",
    render: (onClose: () => void): ReactElement =>
      createElement(CloneRepoDialog, { profile, onCloned: () => undefined, onClose })
  },
  {
    title: "ForkRepoDialog",
    sourceId: "fork-source",
    render: (onClose: () => void): ReactElement =>
      createElement(ForkRepoDialog, {
        profile,
        onForked: () => undefined,
        onReveal: () => undefined,
        onClose
      })
  }
])("$title as a modal", ({ sourceId, render }) => {
  async function open(onClose: () => void = () => undefined): Promise<void> {
    await act(async () => root.render(render(onClose)));
  }

  it("lands focus in the source field", async () => {
    await open();
    expect(document.activeElement?.id).toBe(sourceId);
  });

  it("wraps Tab from the footer back to the top of the dialog", async () => {
    await open();
    // Nothing is chosen yet, so the submit button is disabled and Cancel is
    // the last stop; the title bar's Close is the first.
    button("Cancel").focus();
    press(document.activeElement!, "Tab");
    expect(document.activeElement).toBe(button("Close"));
    press(document.activeElement!, "Tab", true);
    expect(document.activeElement).toBe(button("Cancel"));
  });

  it("closes on Escape from anywhere in the dialog, once", async () => {
    const onClose = vi.fn();
    await open(onClose);
    // The search fields used to call onClose themselves; with useModal owning
    // Escape too, that would have been two closes for one keypress.
    press(document.getElementById(sourceId)!, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);

    // And from a control that is not a search field, which used to do nothing.
    button("Cancel").focus();
    press(document.activeElement!, "Escape");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

it.each([
  "https://chromium.googlesource.com/v8/v8.git",
  "https://github.com/example/project.git",
  "ssh://reviewer@git.example:29418/group/nested/repo.git"
])("submits the supplied URL unchanged without forge verification: %s", async (sourceUrl) => {
  dispatchMock.mockImplementation((channel: string) => {
    if (channel === "repo:cloneCatalog") return Promise.resolve(ok({ owners: [], forges: [] }));
    if (channel === "forge:hosts") return Promise.resolve(ok({ hosts: [], overrides: {} }));
    if (channel === "repo:cloneDestinations") return Promise.resolve(ok([
      { path: "/fixtures", root: "/fixtures", relativePath: "", repoCount: 0 }
    ]));
    return Promise.resolve(ok([]));
  });
  await act(async () => root.render(createElement(CloneRepoDialog, {
    profile, onCloned: () => undefined, onClose: () => undefined
  })));
  const input = document.getElementById("clone-source") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, `git clone ${sourceUrl}`);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  press(input, "Enter");
  expect(container.querySelector(".clone-protocols")?.textContent).toBe(`Supplied URL${sourceUrl}`);
  expect(input.value).toBe(sourceUrl);
  await act(async () => {
    (container.querySelector(".clone-dialog__footer button[type=submit]") ??
      [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Clone repository"))!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(dispatchMock).toHaveBeenCalledWith("repo:clone", expect.objectContaining({ sourceUrl }));
  expect(dispatchMock.mock.calls.some(([channel]) => channel === "repo:checkCloneSource")).toBe(false);
});
