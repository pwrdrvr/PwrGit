// @vitest-environment jsdom

// The one control that takes a version out to its published release page.
// Every update surface renders it, so its three rules are pinned here rather
// than once per surface: it opens through the bus, it never navigates this
// document, and it disappears rather than offering a dead link.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, releaseNotesUrl } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));

import { ReleaseNotesLink } from "./ReleaseNotesLink";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockResolvedValue(ok(null));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(
  props: Parameters<typeof ReleaseNotesLink>[0]
): Promise<void> {
  await act(async () => {
    root.render(<ReleaseNotesLink {...props} />);
  });
}

describe("ReleaseNotesLink", () => {
  it("hands the URL to the bus rather than navigating", async () => {
    await render({ url: releaseNotesUrl("0.16.1"), className: "x" });

    const control = container.querySelector("button");
    expect(control?.textContent).toBe("Release notes");
    await act(async () => {
      control?.click();
    });

    expect(mocks.dispatch).toHaveBeenCalledWith("shell:openExternal", {
      url: "https://github.com/pwrdrvr/PwrGit/releases/tag/v0.16.1"
    });
  });

  it("is a button with no href, so no click can navigate a window", async () => {
    // PwrGit's windows install `setWindowOpenHandler`, so a middle-click on a
    // real anchor is already handed to the OS — but nothing guards SAME-FRAME
    // navigation outside the agent-consent window, so an ordinary left click
    // on an `<a href>` would load github.com into the app frame.
    await render({ url: releaseNotesUrl("0.16.1"), className: "x" });

    expect(container.querySelector("a")).toBeNull();
    const control = container.querySelector("button");
    expect(control?.getAttribute("type")).toBe("button");
    expect(control?.getAttribute("href")).toBeNull();
  });

  it("renders nothing when the version has no published page", async () => {
    // A development build's version is not a published release. An offer to
    // read notes that land on a 404 is worse than no offer.
    await render({ url: releaseNotesUrl("dev-build"), className: "x" });

    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("takes an accessible name for surfaces that render several at once", async () => {
    // Settings → Updates draws one per published slot; four controls all
    // named "Release notes" is not a usable list.
    await render({
      url: releaseNotesUrl("v0.16.0-beta.5"),
      className: "x",
      label: "Notes",
      ariaLabel: "Release notes for Beta Latest v0.16.0-beta.5"
    });

    const control = container.querySelector("button");
    expect(control?.textContent).toBe("Notes");
    expect(control?.getAttribute("aria-label")).toBe(
      "Release notes for Beta Latest v0.16.0-beta.5"
    );
    // The destination is inspectable without taking it — a renderer window has
    // no status bar — but through the house hover card, never a native
    // `title` (#269), which never appears on keyboard focus.
    expect(control?.getAttribute("title")).toBeNull();
    await act(async () => {
      control?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(document.body.textContent).toContain(
      "https://github.com/pwrdrvr/PwrGit/releases/tag/v0.16.0-beta.5"
    );
  });
});
