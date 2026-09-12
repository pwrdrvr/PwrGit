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
    kindSource: "auto",
    enabled: true,
    enabledSource: "auto",
    origin: "cli",
    cli: "gh",
    ...overrides
  };
}

/** A host somebody added by hand: a stored kind is what `kindSource: "config"`
 *  means, and it is the only thing that earns a Remove button. */
function added(overrides: Partial<ForgeHostRow> = {}): ForgeHostRow {
  return host({
    host: "gitlab.contoso.dev",
    kind: "gitlab",
    kindSource: "config",
    cli: "glab",
    origin: "config",
    ...overrides
  });
}

const WRITE_FAILED = err({
  kind: "unknown",
  code: "settings_write_failed",
  message: "Settings could not be written."
});

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

/** Alerts are scoped: the section renders its own `role="alert"` above the
 *  dialog, so an unscoped query can match the wrong one and pass for the wrong
 *  reason. */
function alertIn(scope: ParentNode): string {
  return scope.querySelector("[role='alert']")?.textContent ?? "";
}

function dialog(): HTMLElement {
  const found = container.querySelector<HTMLElement>("[role='dialog']");
  if (found === null) throw new Error("no dialog open");
  return found;
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

  it("writes the hostname, the product and an explicit on, then re-reads", async () => {
    await render();
    mocks.dispatch.mockClear();

    await click(button("Add GitHub Enterprise…"));
    await typeHostname("ghe.acme-inc.com");
    // Main is what turns the entry into a row; stand in for it having stored it.
    rows = [...rows, added({ host: "ghe.acme-inc.com", kind: "github", cli: "gh" })];
    await click(button("Add host"));

    // `enabled: true` is not decoration. Main MERGES into the stored entry, so
    // a stale `enabled:false` from a since-signed-out CLI would otherwise
    // survive and the host would arrive switched off.
    expect(writes).toEqual([
      { forgeHosts: { "ghe.acme-inc.com": { kind: "github", enabled: true } } }
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
      {
        forgeHosts: {
          "gitlab.internal.example": { kind: "gitlab", enabled: true }
        }
      }
    ]);
  });

  it("canonicalizes the hostname the way the write path does", async () => {
    // A key stored under a spelling no lookup matches is a setting that looks
    // saved and silently does nothing, so the pane must not send one.
    await render();

    await add("Add GitHub Enterprise…", "  WWW.GHE.Acme-Inc.Com  ");

    expect(writes).toEqual([
      { forgeHosts: { "ghe.acme-inc.com": { kind: "github", enabled: true } } }
    ]);
  });

  it("refuses a pasted URL in front of the user instead of writing one main drops", async () => {
    await render();

    await add("Add GitHub Enterprise…", "https://ghe.acme-inc.com/");

    expect(writes).toEqual([]);
    // Names no specific cause: the shared regex also rejects underscores, a
    // trailing dot and non-ASCII labels, and listing scheme/port/path told
    // those users they had done something they had not.
    expect(alertIn(dialog())).toContain("That is not a hostname");
    // Still open, with what they typed, so the fix is one edit away.
    expect(container.querySelector("[role='dialog']")).not.toBeNull();
  });

  it("refuses a host already on the list rather than writing a no-op", async () => {
    await render([host({ host: "github.com" })]);

    await add("Add GitHub Enterprise…", "github.com");

    expect(writes).toEqual([]);
    expect(alertIn(dialog())).toContain("github.com is already on the list.");
  });

  it("keeps the dialog open and says why when the write fails", async () => {
    await render();
    writeResult = WRITE_FAILED;

    await add("Add GitHub Enterprise…", "ghe.acme-inc.com");

    expect(container.querySelector("[role='dialog']")).not.toBeNull();
    expect(alertIn(dialog())).toContain("Settings could not be written.");
  });

  it("reaches the add buttons with no host on the list at all", async () => {
    // The state this feature matters most in: nothing enumerated, so without a
    // reachable affordance there is no way to name an instance. An empty list
    // is still a LOADED list, so the buttons must be live here.
    await render([]);

    expect(container.textContent).toContain("Neither");
    expect(button("Add GitHub Enterprise…").disabled).toBe(false);
  });

  it("will not open the dialog before the list is known", async () => {
    // The duplicate check reads the rendered list. Against an unloaded one it
    // waves everything through, and an add that lands on an existing host
    // rewrites its product — sending that instance's metadata at the other CLI.
    let settle: ((value: unknown) => void) | undefined;
    mocks.dispatch.mockImplementation(async (channel: string) => {
      if (channel === "forge:hosts") {
        return await new Promise((resolve) => {
          settle = resolve;
        });
      }
      return writeResult;
    });
    await act(async () => {
      root.render(<ForgeHostsSection saving={false} />);
    });

    expect(button("Add GitHub Enterprise…").disabled).toBe(true);
    await click(button("Add GitHub Enterprise…"));
    expect(container.querySelector("[role='dialog']")).toBeNull();

    await act(async () => settle?.(ok({ hosts: [host()] })));
    expect(button("Add GitHub Enterprise…").disabled).toBe(false);
  });

  it("submits nothing when Enter lands on an untouched field", async () => {
    // The Enter path used to bypass the button's own unavailable condition and
    // report an empty field as a malformed hostname.
    await render();
    await click(button("Add GitHub Enterprise…"));

    const field = dialog().querySelector<HTMLInputElement>(".modal__input")!;
    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });

    expect(writes).toEqual([]);
    expect(alertIn(dialog())).toBe("");
  });

  it("re-announces an identical rejection instead of going silent", async () => {
    // React bails out of a state update to the same string, so resubmitting an
    // unchanged bad value left the alert node untouched and a reader silent.
    await render();
    await click(button("Add GitHub Enterprise…"));
    await typeHostname("https://ghe.acme-inc.com/");

    await click(button("Add host"));
    const first = dialog().querySelector("[role='alert']");
    await click(button("Add host"));
    const second = dialog().querySelector("[role='alert']");

    expect(first?.textContent).toContain("That is not a hostname");
    expect(second?.textContent).toContain("That is not a hostname");
    expect(second).not.toBe(first);
  });

  it("sends one write when the confirm button is double-clicked", async () => {
    // `busy` is render state and the pane's own `saving` is never true for its
    // direct dispatches, so only a synchronous ref can gate this.
    await render();
    await click(button("Add GitHub Enterprise…"));
    await typeHostname("ghe.acme-inc.com");

    const confirm = button("Add host");
    await act(async () => {
      confirm.click();
      confirm.click();
    });

    expect(writes).toHaveLength(1);
  });
});

describe("ForgeHostsSection — removing a hand-added host", () => {
  const removeButton = (hostname: string): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(
      `[aria-label='Remove host ${hostname}']`
    );

  /** The row a Remove button belongs to, so a row-scoped assertion cannot pass
   *  by matching some other row's text. */
  const rowFor = (hostname: string): HTMLElement => {
    const found = [...container.querySelectorAll<HTMLElement>(".settings-field")]
      .find((field) => field.textContent?.includes(hostname) === true);
    if (found === undefined) throw new Error(`no row for ${hostname}`);
    return found;
  };

  it("clears the whole entry, which is what makes the row go away", async () => {
    await render([added()]);
    mocks.dispatch.mockClear();

    rows = [];
    await click(removeButton("gitlab.contoso.dev")!);

    // `null`, not `{kind: undefined}`: the kind is the only thing naming the
    // product, so clearing the entry is what removes the host.
    expect(writes).toEqual([{ forgeHosts: { "gitlab.contoso.dev": null } }]);
    expect(mocks.dispatch).toHaveBeenCalledWith("forge:hosts", {});
    expect(container.textContent).not.toContain("gitlab.contoso.dev");
  });

  it("offers Remove on a stored product even once a CLI reports the host", async () => {
    // `origin` flips to "cli" the moment enumeration finds an account, but the
    // stored kind still overrides what the CLI reported — so gating Remove on
    // origin made a mis-chosen product permanent.
    await render([
      added({ origin: "cli", account: "o.dev" })
    ]);

    expect(removeButton("gitlab.contoso.dev")).not.toBeNull();
  });

  it("offers no Remove for a host nobody chose a product for", async () => {
    // The dangerous case: a host the user merely switched OFF resolves its kind
    // from the SaaS fallback and reports origin "config" once its CLI signs
    // out. Clearing that entry would DELETE the `enabled:false` and turn the
    // host back on, with no row left to turn it off again.
    await render([
      host({ enabled: false, enabledSource: "config", origin: "config" })
    ]);

    expect(removeButton("github.com")).toBeNull();
    expect(container.textContent).not.toContain("Added by you");
    // And it gets the explanation `sourceNote` exists to give.
    expect(container.textContent).toContain("PwrGit runs no command");
  });

  it("explains an env-pinned switch on a hand-added host", async () => {
    // Every config row used to take the "Added by you" branch, which made
    // `sourceNote` unreachable — so a switch that cannot move said nothing.
    await render([added({ enabled: false, enabledSource: "env" })]);

    expect(container.textContent).toContain("Added by you");
    expect(container.textContent).toContain("environment variable");
  });

  it("shows a failed removal on the row it belongs to", async () => {
    await render([added(), added({ host: "gitlab.other.dev" })]);
    writeResult = WRITE_FAILED;

    await click(removeButton("gitlab.contoso.dev")!);

    // Row-scoped, so it cannot pass by finding a section-level banner that
    // names no host — which is what the previous version of this test did.
    expect(alertIn(rowFor("gitlab.contoso.dev"))).toContain(
      "Settings could not be written."
    );
    expect(alertIn(rowFor("gitlab.other.dev"))).toBe("");
  });

  it("sends one write when Remove is double-clicked", async () => {
    await render([added()]);
    const remove = removeButton("gitlab.contoso.dev")!;

    await act(async () => {
      remove.click();
      remove.click();
    });

    expect(writes).toEqual([{ forgeHosts: { "gitlab.contoso.dev": null } }]);
  });
});
