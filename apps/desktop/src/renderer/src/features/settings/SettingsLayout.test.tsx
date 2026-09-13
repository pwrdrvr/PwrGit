// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
  __resetCollapsedPanesForTests,
  type SettingsFocusRequest
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
  // Cleared, not just stepped around: the map is module state, so the two
  // tests below that reuse a fixed pane id would otherwise inherit whatever a
  // previous run of this file left there.
  __resetCollapsedPanesForTests();
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
    // Nothing left to collapse, so the control that would do it is unavailable
    // — but `aria-disabled`, never `disabled`. Activating it is what makes it
    // unavailable, and Chromium blurs an element the moment it goes `disabled`,
    // dropping a keyboard user on <body> mid-gesture (SC 2.4.3).
    expect(button("Collapse all").getAttribute("aria-disabled")).toBe("true");
    expect(button("Collapse all").disabled).toBe(false);
    expect(button("Expand all").getAttribute("aria-disabled")).toBe("false");

    await act(async () => button("Expand all").click());
    expect(header("First").getAttribute("aria-expanded")).toBe("true");
    expect(button("Expand all").getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps focus on a bulk control that has just made itself unavailable", async () => {
    // The whole reason these are aria-disabled: a keyboard user Tabs to
    // Collapse all and presses Enter, and a real `disabled` would blur the
    // button they are standing on, leaving nothing to Shift+Tab back from.
    await renderStack();
    const collapse = button("Collapse all");
    collapse.focus();

    await act(async () => collapse.click());

    expect(collapse.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(collapse);
  });

  it("refuses a second Collapse all rather than relying on the attribute", async () => {
    // aria-disabled stops nothing on its own, so the handler has to.
    await renderStack();
    await act(async () => button("Collapse all").click());
    await act(async () => button("Collapse all").click());

    expect(header("First").getAttribute("aria-expanded")).toBe("false");
    expect(header("Second").getAttribute("aria-expanded")).toBe("false");
  });

  it("roves in DOM order when a section mounts after its neighbours", async () => {
    // Registration order is MOUNT order. A section that appears later — a
    // conditional editor, a section whose sectionId changed — would sort last
    // and ArrowDown would skip the header that is visually next.
    function Pane(props: { withMiddle: boolean }) {
      return (
        <SettingsSectionStack aria-label="Test pane" paneId={`order-${paneSeq}`}>
          <SettingsPanelHead eyebrow="Test" title="Test pane" />
          <SettingsSection title="First">
            <p>first</p>
          </SettingsSection>
          {props.withMiddle ? (
            <SettingsSection title="Middle">
              <p>middle</p>
            </SettingsSection>
          ) : null}
          <SettingsSection title="Last">
            <p>last</p>
          </SettingsSection>
        </SettingsSectionStack>
      );
    }

    await act(async () => root.render(<Pane withMiddle={false} />));
    await act(async () => root.render(<Pane withMiddle />));

    header("First").focus();
    await press(header("First"), "ArrowDown");

    expect(document.activeElement).toBe(header("Middle"));
  });

  it("keeps two titles that slug alike as two separate sections", async () => {
    // "Memory / CPU" and "Memory CPU" both slug to `memory-cpu`. Sharing an id
    // makes registerSection REPLACE, so one header vanishes from roving, both
    // fold together, and both bodies render the same DOM id.
    await act(async () => {
      root.render(
        <SettingsSectionStack aria-label="Test pane" paneId={`slug-${paneSeq}`}>
          <SettingsPanelHead eyebrow="Test" title="Test pane" />
          <SettingsSection title="Memory / CPU">
            <p>a</p>
          </SettingsSection>
          <SettingsSection title="Memory CPU">
            <p>b</p>
          </SettingsSection>
        </SettingsSectionStack>
      );
    });

    expect(body("Memory / CPU").id).not.toBe(body("Memory CPU").id);

    await act(async () => header("Memory / CPU").click());

    expect(header("Memory / CPU").getAttribute("aria-expanded")).toBe("false");
    expect(header("Memory CPU").getAttribute("aria-expanded")).toBe("true");
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

describe("SettingsSectionStack — nav reveal", () => {
  /** The same two-section pane, plus whatever the nav is asking for. */
  async function renderWithFocus(
    focusSection: SettingsFocusRequest | undefined
  ): Promise<void> {
    await act(async () => {
      root.render(
        <SettingsSectionStack
          aria-label="Test pane"
          paneId={`focus-pane-${paneSeq}`}
          {...(focusSection === undefined ? {} : { focusSection })}
        >
          <SettingsPanelHead eyebrow="Test" title="Test pane" />
          <SettingsSection sectionId="first" title="First">
            <button type="button">inside first</button>
          </SettingsSection>
          <SettingsSection sectionId="second" title="Second">
            <button type="button">inside second</button>
          </SettingsSection>
        </SettingsSectionStack>
      );
    });
  }

  it("focuses the card the nav asked for", async () => {
    // Focus and not merely a scroll: a reader who arrived from the nav by
    // keyboard has to be able to Tab straight into the card, and one who
    // arrived by mouse gets the focus ring as confirmation of where they are.
    await renderWithFocus({ sectionId: "second" });

    expect(document.activeElement).toBe(header("Second"));
  });

  it("unfolds a card it was sent to", async () => {
    // Otherwise the nav scrolls to a collapsed header and the reader is told
    // nothing — the card they asked for is the one thing not on screen.
    await renderWithFocus(undefined);
    await act(async () => header("Second").click());
    expect(header("Second").getAttribute("aria-expanded")).toBe("false");

    await renderWithFocus({ sectionId: "second" });

    expect(header("Second").getAttribute("aria-expanded")).toBe("true");
    // Only the one asked for. Unfolding the pane would discard every other
    // fold the reader had made to get the pane down to what they care about.
    expect(header("First").getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves a fold alone when the request has not changed", async () => {
    // Requests are honored once. Sections re-register whenever one is added or
    // re-keyed — a probe landing is enough — and re-running the reveal would
    // both yank the scroll back and re-open a card the reader had just folded.
    const request: SettingsFocusRequest = { sectionId: "second" };
    await renderWithFocus(request);
    await act(async () => header("Second").click());

    await renderWithFocus(request);

    expect(header("Second").getAttribute("aria-expanded")).toBe("false");
  });

  it("honors the same card again once the nav has dropped the request", async () => {
    // Clicking the parent row and then the child again is one of the two ways
    // back to a card the reader has scrolled away from; comparing slugs rather
    // than requests would make the second click do nothing at all.
    const first: SettingsFocusRequest = { sectionId: "second" };
    await renderWithFocus(first);
    await act(async () => header("Second").click());
    await renderWithFocus(undefined);

    await renderWithFocus({ sectionId: "second" });

    expect(header("Second").getAttribute("aria-expanded")).toBe("true");
  });

  it("ignores a card that is not in this pane", async () => {
    // A slug with no section is not an error to report — it is a nav and a
    // pane that have drifted, and the pane's job is to render normally.
    await renderWithFocus({ sectionId: "nonexistent" });

    expect(document.activeElement).toBe(document.body);
    expect(header("First").getAttribute("aria-expanded")).toBe("true");
  });
});
