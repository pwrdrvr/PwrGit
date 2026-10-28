// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppProcessIds } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatchOrThrow: vi.fn(),
  copyText: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({ dispatchOrThrow: mocks.dispatchOrThrow }));
vi.mock("../../lib/copyText", () => ({ copyText: mocks.copyText }));

import { DeveloperToolsSection } from "./DeveloperToolsSection";

const FIRST: AppProcessIds = {
  line: "main=311 gpu=315 renderer=330",
  diagnosticsText: "PwrGit 1.0.0\nProcesses: main=311 gpu=315 renderer=330"
};
const LATER: AppProcessIds = {
  line: "main=311 gpu=315 renderer=330,341",
  diagnosticsText: "PwrGit 1.0.0\nProcesses: main=311 gpu=315 renderer=330,341"
};

function card(platform?: string) {
  return (
    <DeveloperToolsSection
      saving={false}
      developerMode={false}
      onDeveloperModeChange={() => undefined}
      {...(platform === undefined ? {} : { platform })}
    />
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatchOrThrow.mockResolvedValue(FIRST);
  mocks.copyText.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DeveloperToolsSection developer shortcut copy", () => {
  it("preserves the native macOS menu chords", () => {
    expect(renderToStaticMarkup(card("darwin"))).toContain("⌘R, ⇧⌘R, ⌥⌘I");
  });

  it("names the Windows menu chords with Ctrl", () => {
    expect(renderToStaticMarkup(card("win32"))).toContain(
      "Ctrl+R, Ctrl+Shift+R, Ctrl+Shift+I"
    );
  });
});

describe("DeveloperToolsSection process ids", () => {
  it("shows the live table and copies a fresh read, not the one on screen", async () => {
    await act(async () => {
      root.render(card());
    });
    expect(mocks.dispatchOrThrow).toHaveBeenCalledWith(
      "app:readProcessIds",
      undefined
    );
    expect(container.textContent).toContain(FIRST.line);

    mocks.dispatchOrThrow.mockResolvedValue(LATER);
    const copy = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Copy process IDs"
    );
    await act(async () => copy?.click());

    expect(mocks.copyText).toHaveBeenCalledWith(LATER.diagnosticsText);
    expect(container.textContent).toContain(LATER.line);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Process IDs copied."
    );
  });

  it("says Unavailable when main cannot answer", async () => {
    mocks.dispatchOrThrow.mockRejectedValue(new Error("no bus"));
    await act(async () => {
      root.render(card());
    });
    expect(container.textContent).toContain("Unavailable");
  });
});
