// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type ForgeHostRow } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));

import { ForgeHostsSection } from "./ForgeHostsSection";

function host(overrides: Partial<ForgeHostRow> = {}): ForgeHostRow {
  return {
    host: "github.com",
    kind: "github",
    enabled: true,
    enabledSource: "auto",
    origin: "cli",
    cli: "gh",
    ...overrides
  };
}

let container: HTMLDivElement;
let root: Root;
/** What `forge:hosts` answers. A test that writes may replace it, standing in
 *  for main having stored the entry. */
let rows: ForgeHostRow[];
/** What `settings:update` answers. */
let writeResult: unknown;

/** Every `settings:update` patch the pane sent, in order — the contract with
 *  main, and the thing a UI-only change can still get wrong. */
let writes: unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  rows = [host()];
  writeResult = ok({});
  writes = [];
  mocks.dispatch.mockImplementation(async (channel: string, req: unknown) => {
    if (channel === "forge:hosts") return ok({ hosts: rows });
    if (channel === "settings:update") {
      writes.push((req as { patch: unknown }).patch);
      return writeResult;
    }
    throw new Error(`unexpected channel: ${channel}`);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(initial?: ForgeHostRow[]): Promise<void> {
  if (initial !== undefined) rows = initial;
  await act(async () => {
    root.render(<ForgeHostsSection saving={false} />);
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name
  );
  if (found === undefined) throw new Error(`no button labelled "${name}"`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

async function typeHostname(value: string): Promise<void> {
  const field = container.querySelector<HTMLInputElement>(
    "[role='dialog'] .modal__input"
  )!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Open the add dialog for a product, type a hostname, submit. */
async function add(product: string, hostname: string): Promise<void> {
  await click(button(product));
  await typeHostname(hostname);
  await click(button("Add host"));
}

describe("ForgeHostsSection — adding a host by hand", () => {
  it("offers one button per product, because the product is chosen not guessed", async () => {
    await render();

    expect(button("Add GitHub Enterprise…")).toBeTruthy();
    expect(button("Add GitLab instance…")).toBeTruthy();
    // The rule this UI exists to uphold, said where the user is deciding.
    expect(container.textContent).toContain(
      "You name the host and its product. Nothing is inferred from a hostname, and no ssh remote ever appears here on its own."
    );
  });

  it("writes the hostname and the product together, then re-reads from main", async () => {
    await render();
    mocks.dispatch.mockClear();

    await click(button("Add GitHub Enterprise…"));
    await typeHostname("ghe.acme-inc.com");
    // Main is what turns the entry into a row; stand in for it having stored it.
    rows = [...rows, host({ host: "ghe.acme-inc.com", origin: "config" })];
    await click(button("Add host"));

    expect(writes).toEqual([
      { forgeHosts: { "ghe.acme-inc.com": { kind: "github" } } }
    ]);
    // Re-read, and never as a refresh: a config entry changes nothing either
    // CLI would report, and a refresh spawns two subprocesses to learn that.
    expect(mocks.dispatch).toHaveBeenCalledWith("forge:hosts", {});
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(container.textContent).toContain("ghe.acme-inc.com");
  });

  it("carries the other product when the GitLab button opened the dialog", async () => {
    await render();

    await add("Add GitLab instance…", "gitlab.internal.example");

    expect(writes).toEqual([
      { forgeHosts: { "gitlab.internal.example": { kind: "gitlab" } } }
    ]);
  });

  it("canonicalizes the hostname the way the write path does", async () => {
    // A key stored under a spelling no lookup matches is a setting that looks
    // saved and silently does nothing, so the pane must not send one.
    await render();

    await add("Add GitHub Enterprise…", "  WWW.GHE.Acme-Inc.Com  ");

    expect(writes).toEqual([
      { forgeHosts: { "ghe.acme-inc.com": { kind: "github" } } }
    ]);
  });

  it("refuses a pasted URL in front of the user instead of writing one main drops", async () => {
    await render();

    await add("Add GitHub Enterprise…", "https://ghe.acme-inc.com/");

    expect(writes).toEqual([]);
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Enter just the hostname"
    );
    // Still open, with what they typed, so the fix is one edit away.
    expect(container.querySelector("[role='dialog']")).not.toBeNull();
  });

  it("refuses a host already on the list rather than writing a no-op", async () => {
    await render([host({ host: "github.com" })]);

    await add("Add GitHub Enterprise…", "github.com");

    expect(writes).toEqual([]);
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "github.com is already on the list."
    );
  });

  it("keeps the dialog open and says why when the write fails", async () => {
    await render();
    writeResult = err({
      kind: "unknown",
      code: "settings_write_failed",
      message: "Settings could not be written."
    });

    await add("Add GitHub Enterprise…", "ghe.acme-inc.com");

    expect(container.querySelector("[role='dialog']")).not.toBeNull();
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Settings could not be written."
    );
  });

  it("reaches the add buttons with no host on the list at all", async () => {
    // The state this feature matters most in: nothing enumerated, so without a
    // reachable affordance there is no way to name an instance.
    await render([]);

    expect(container.textContent).toContain("Neither");
    expect(button("Add GitHub Enterprise…")).toBeTruthy();
  });
});

describe("ForgeHostsSection — removing a hand-added host", () => {
  const added = host({
    host: "gitlab.contoso.dev",
    kind: "gitlab",
    cli: "glab",
    origin: "config",
    enabledSource: "auto"
  });

  it("clears the whole entry, which is what makes the row go away", async () => {
    await render([added]);
    mocks.dispatch.mockClear();

    const remove = container.querySelector<HTMLButtonElement>(
      "[aria-label='Remove host gitlab.contoso.dev']"
    )!;
    rows = [];
    await click(remove);

    // `null`, not `{kind: undefined}`: the kind is the only thing naming the
    // product, so clearing the entry is what removes the host.
    expect(writes).toEqual([{ forgeHosts: { "gitlab.contoso.dev": null } }]);
    expect(mocks.dispatch).toHaveBeenCalledWith("forge:hosts", {});
    expect(container.textContent).not.toContain("gitlab.contoso.dev");
  });

  it("offers no Remove for a host a CLI reported", async () => {
    // Removing it would clear a setting and leave the row exactly where it is,
    // because enumeration — not config — is what put it there.
    await render([host({ account: "octo-dev" })]);

    expect(
      container.querySelector("[aria-label='Remove host github.com']")
    ).toBeNull();
    expect(container.textContent).toContain("signed in as octo-dev");
  });

  it("shows a failed removal on the row it belongs to", async () => {
    await render([added]);
    writeResult = err({
      kind: "unknown",
      code: "settings_write_failed",
      message: "Settings could not be written."
    });

    await click(
      container.querySelector<HTMLButtonElement>(
        "[aria-label='Remove host gitlab.contoso.dev']"
      )!
    );

    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Settings could not be written."
    );
    expect(container.textContent).toContain("gitlab.contoso.dev");
  });
});
