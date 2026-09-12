// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack
} from "./SettingsLayout";

/**
 * The collapsible-section machinery, ported from PwrAgnt.
 *
 * Settings → Forges is what made it necessary: a pane with one section per
 * product, and a third product queued behind GitHub and GitLab.
 */
let container: HTMLDivElement;
let root: Root;
/**
 * A fresh pane id per test.
 *
 * Collapse state is kept for the life of the window, keyed by pane — that is
 * the feature. So a shared id makes one test's fold the next test's starting
 * state, and the two tests below that DO want that share an id on purpose.
 */
let paneSeq = 0;

beforeEach(() => {
  paneSeq += 1;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderStack(paneId?: string): Promise<void> {
  const id = paneId ?? `test-pane-${paneSeq}`;
  await act(async () => {
    root.render(
      <SettingsSectionStack aria-label="Test pane" paneId={id}>
        <SettingsPanelHead eyebrow="Test" title="Test pane" />
        <SettingsSection title="First">
          <button type="button">inside first</button>
        </SettingsSection>
        <SettingsSection title="Second">
          <button type="button">inside second</button>
        </SettingsSection>
      </SettingsSectionStack>
    );
  });
}

function header(title: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    `[role='button'][aria-label='${title}']`
  );
  if (found === null) throw new Error(`no disclosure header for ${title}`);
  return found;
}

function body(title: string): HTMLElement {
  const id = header(title).getAttribute("aria-controls");
  const found = id === null ? null : container.querySelector<HTMLElement>(`#${id}`);
  if (found === null) throw new Error(`no body for ${title}`);
  return found;
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name
  );
  if (found === undefined) throw new Error(`no button labelled "${name}"`);
  return found;
}

async function press(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("SettingsSection — disclosure", () => {
  it("opens expanded and folds on click", async () => {
    await renderStack();

    expect(header("First").getAttribute("aria-expanded")).toBe("true");
    await act(async () => header("First").click());

    expect(header("First").getAttribute("aria-expanded")).toBe("false");
    // Its neighbour is untouched — folding is per section, not per pane.
    expect(header("Second").getAttribute("aria-expanded")).toBe("true");
  });

  it("takes a folded body out of the tab order, not just out of the a11y tree", async () => {
    // `aria-hidden` alone leaves the controls inside focusable, so Tab walks
    // into a section the user has closed and lands on something invisible.
    await renderStack();
    await act(async () => header("First").click());

    expect(body("First").hasAttribute("inert")).toBe(true);
    expect(body("Second").hasAttribute("inert")).toBe(false);
  });

  it("answers Enter and Space, which a div with role=button gets neither of", async () => {
    await renderStack();

    await press(header("First"), "Enter");
    expect(header("First").getAttribute("aria-expanded")).toBe("false");

    await press(header("First"), " ");
    expect(header("First").getAttribute("aria-expanded")).toBe("true");
  });

  it("moves focus between section headers with the arrow keys", async () => {
    await renderStack();
    header("First").focus();

    await press(header("First"), "ArrowDown");
    expect(document.activeElement).toBe(header("Second"));

    await press(header("Second"), "ArrowUp");
    expect(document.activeElement).toBe(header("First"));

    await press(header("First"), "End");
    expect(document.activeElement).toBe(header("Second"));

    await press(header("Second"), "Home");
    expect(document.activeElement).toBe(header("First"));
  });

  it("stops at the ends rather than wrapping", async () => {
    await renderStack();
    header("First").focus();

    await press(header("First"), "ArrowUp");

    expect(document.activeElement).toBe(header("First"));
  });

  it("collapses and expands every section from the pane head", async () => {
    await renderStack();

    await act(async () => button("Collapse all").click());
    expect(header("First").getAttribute("aria-expanded")).toBe("false");
    expect(header("Second").getAttribute("aria-expanded")).toBe("false");
    // Nothing left to collapse, so the control that would do it is unavailable.
    expect(button("Collapse all").disabled).toBe(true);
    expect(button("Expand all").disabled).toBe(false);

    await act(async () => button("Expand all").click());
    expect(header("First").getAttribute("aria-expanded")).toBe("true");
    expect(button("Expand all").disabled).toBe(true);
  });

  it("remembers a fold across a trip to another pane", async () => {
    // Switching panes in the left nav unmounts this one entirely. A fold is a
    // reading position, and losing it on every trip makes the control useless
    // on exactly the long panes it exists for.
    await renderStack("sticky-pane");
    await act(async () => header("First").click());

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderStack("sticky-pane");

    expect(header("First").getAttribute("aria-expanded")).toBe("false");
    expect(header("Second").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps each pane's folds to itself", async () => {
    await renderStack("pane-a");
    await act(async () => header("First").click());

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderStack("pane-b");

    expect(header("First").getAttribute("aria-expanded")).toBe("true");
  });

  it("renders a plain card outside a stack, promising no fold it cannot keep", async () => {
    // `AgentConsentWindow` renders a section on its own. There is no pane to
    // remember the state, so offering a chevron would be a lie.
    await act(async () => {
      root.render(
        <SettingsSection title="Session permissions">
          <p>body</p>
        </SettingsSection>
      );
    });

    expect(container.querySelector("[role='button']")).toBeNull();
    expect(container.querySelector(".settings-panel__chevron")).toBeNull();
    expect(container.textContent).toContain("body");
  });

  it("offers no bulk controls on a pane with no sections", async () => {
    await act(async () => {
      root.render(
        <SettingsSectionStack aria-label="Empty" paneId="empty">
          <SettingsPanelHead eyebrow="Test" title="Empty pane" />
        </SettingsSectionStack>
      );
    });

    expect(container.textContent).not.toContain("Collapse all");
  });
});
