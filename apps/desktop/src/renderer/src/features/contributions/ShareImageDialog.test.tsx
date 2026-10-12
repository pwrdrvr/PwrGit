// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContributionSnapshot } from "@pwrgit/shared";
import { contributionFixture } from "./contribution-fixture";

const mocks = vi.hoisted(() => ({
  copy: vi.fn(),
  png: vi.fn()
}));
vi.mock("../diff/image-clipboard", () => ({ copyPngToClipboard: mocks.copy }));
vi.mock("./share-image", async (original) => ({
  ...(await original<typeof import("./share-image")>()),
  shareImagePng: mocks.png
}));
import { ShareImageDialog } from "./ShareImageDialog";

const PREFS_KEY = "pwrgit.contributions.share.demo-profile.github.com.DEMO_U1";
let container: HTMLDivElement, root: Root, snapshot: ContributionSnapshot;
let onClose: ReturnType<typeof vi.fn<() => void>>;

/** The SVG behind the preview, i.e. exactly what Copy rasterizes. */
const picture = () =>
  decodeURIComponent(
    container.querySelector<HTMLImageElement>("figure img")!.src.split(",")[1]!
  );
const radio = (group: string, label: string) =>
  [
    ...container.querySelectorAll<HTMLInputElement>(
      `[role="radiogroup"][aria-label="${group}"] input`
    )
  ].find((input) => input.parentElement?.textContent === label)!;
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label
  )!;
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function open() {
  await act(async () =>
    root.render(
      <main className="contributions">
        <ShareImageDialog
          profileId="demo-profile"
          snapshot={snapshot}
          options={{ metric: "merged", group: "org", interval: "day", topN: 6 }}
          onClose={onClose}
        />
      </main>
    )
  );
}

beforeEach(() => {
  window.localStorage.clear();
  snapshot = contributionFixture();
  onClose = vi.fn<() => void>();
  mocks.png
    .mockReset()
    .mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  mocks.copy.mockReset().mockResolvedValue(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("Share image dialog", () => {
  it("masks every org on first open and shows only the viewer's own namespace", async () => {
    await open();
    expect(picture()).toContain("personal:demo-user");
    expect(picture()).toContain("Org A");
    for (let i = 0; i < 7; i++) expect(picture()).not.toContain(`demo-org${i}`);
    expect(container.textContent).toContain("appears as “Org A”");
  });

  it("names exactly the org the user reveals, and remembers it for the account", async () => {
    await open();
    await click(radio("demo-org1 in the image", "Show"));
    expect(picture()).toContain("demo-org1");
    expect(picture()).not.toContain("demo-org0");
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY)!)).toMatchObject({
      names: { DEMO_O1: "show" }
    });

    await act(async () => root.unmount());
    root = createRoot(container);
    await open();
    expect(radio("demo-org1 in the image", "Show").checked).toBe(true);
    expect(picture()).toContain("demo-org1");
  });

  it("drops every name for total only, and the account name on request", async () => {
    await open();
    await click(button("Show all"));
    await click(radio("Break down by", "Total only"));
    expect(picture()).not.toMatch(/demo-org|Org A|Other/);
    expect(container.textContent).not.toContain("Names in the image");
    const account = container.querySelector<HTMLInputElement>(
      "input[type='checkbox']"
    )!;
    await click(account);
    expect(picture()).not.toContain("demo-user");
  });

  it("copies the previewed picture as a PNG and says so", async () => {
    vi.useFakeTimers();
    await open();
    await click(button("Copy image"));
    expect(mocks.png).toHaveBeenCalledWith(picture());
    expect(mocks.copy).toHaveBeenCalledWith(
      await mocks.png.mock.results[0]!.value
    );
    expect(button("Copied")).toBeDefined();
    expect(container.querySelector("[role='status']")?.textContent).toBe(
      "Copied to the clipboard"
    );
    await act(async () => vi.advanceTimersByTime(2000));
    expect(button("Copy image")).toBeDefined();
  });

  it("reports a failed copy instead of claiming success", async () => {
    mocks.copy.mockResolvedValue(false);
    await open();
    await click(button("Copy image"));
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Could not make the image"
    );
    expect(button("Copy image")).toBeDefined();
  });

  it("closes on Escape without closing the screen beneath it", async () => {
    const screenEscape = vi.fn();
    await act(async () =>
      root.render(
        <main
          className="contributions"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented)
              screenEscape();
          }}
        >
          <ShareImageDialog
            profileId="demo-profile"
            snapshot={snapshot}
            options={{ metric: "merged" }}
            onClose={onClose}
          />
        </main>
      )
    );
    const focused = document.activeElement as HTMLElement;
    expect(container.contains(focused)).toBe(true);
    await act(async () =>
      focused.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true
        })
      )
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screenEscape).not.toHaveBeenCalled();
  });
});
