// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  err,
  FORGE_KINDS,
  forgeProduct,
  ok,
  type ForgeHostRow,
  type ForgeStatus
} from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn() }));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));

import { ForgesSettings } from "./ForgesSettings";
import { __resetCollapsedPanesForTests } from "./SettingsLayout";

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

/** A probe answer for both products. This file is about the host rows; the
 *  status half is `ForgesSettings.test.tsx`. Installed and signed in, so no
 *  section paints a remedy over the rows under test. */
function statuses(loggedIn = true): ForgeStatus[] {
  return FORGE_KINDS.map((kind) => ({
    kind,
    cli: forgeProduct(kind).cli,
    installed: true,
    loggedIn,
    capabilities: {
      batchedBranchLookup: true,
      batchedCommitAssociation: true,
      changeSizeAndTimeline: true,
      commitAuthorIdentity: true,
      forkDefaultBranchOnly: true
    },
    hosts: []
  }));
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
/** What `forge:status` answers. Replaced by a test that needs a product in a
 *  state other than plain signed-in. */
let forges: () => ForgeStatus[];

/** Every `settings:update` patch the pane sent, in order — the contract with
 *  main, and the thing a UI-only change can still get wrong. */
let writes: unknown[];

beforeEach(() => {
  // This pane's real id is `forges`, and collapse state is module-level —
  // so without this a folded section survives into the next test.
  __resetCollapsedPanesForTests();
  vi.clearAllMocks();
  rows = [host()];
  forges = () => statuses();
  writeResult = ok({});
  writes = [];
  mocks.subscribe.mockImplementation(() => () => {});
  mocks.dispatch.mockImplementation(async (channel: string, req: unknown) => {
    if (channel === "forge:hosts") return ok({ hosts: rows });
    if (channel === "forge:status") return ok({ forges: forges() });
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
    root.render(<ForgesSettings saving={false} />);
  });
}

/** One product's section, so a row assertion cannot pass by matching the other
 *  product's — the whole point of the split. */
function section(product: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    `section[aria-label='${product}']`
  );
  if (found === null) throw new Error(`no section for ${product}`);
  return found;
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

/** The short-name box on one host's row. */
function nameField(hostname: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(
    `input[aria-label="Name for ${hostname}"]`
  );
  if (found === null) throw new Error(`no short-name field for ${hostname}`);
  return found;
}

/** React delegates `onBlur` from the bubbling `focusout`, so a plain `blur`
 *  event dispatched on the element never reaches it. */
async function blur(field: HTMLInputElement): Promise<void> {
  await act(async () => {
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

async function typeInto(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Settings → Forges — naming a host", () => {
  it("shows the name the chip will use as the placeholder", async () => {
    // The field states the default rather than describing it: what is greyed
    // out here is exactly what the sidebar prints while it is empty.
    await render([
      host(),
      added({
        host: "github.acme.huge-corp.southeast.us.corp",
        kind: "github",
        cli: "gh"
      })
    ]);

    expect(nameField("github.com").placeholder).toBe("GitHub");
    expect(
      nameField("github.acme.huge-corp.southeast.us.corp").placeholder
    ).toBe("acme");
  });

  it("falls back to the hostname when two hosts derive the same name", async () => {
    // A chip that answers "which one?" with the same word twice is worse than
    // the long hostname it replaced, so the placeholder says so up front.
    await render([
      added({ host: "github.acme.example", kind: "github", cli: "gh" }),
      added({ host: "gitlab.acme.example" })
    ]);

    expect(nameField("github.acme.example").placeholder).toBe(
      "github.acme.example"
    );
    expect(nameField("gitlab.acme.example").placeholder).toBe(
      "gitlab.acme.example"
    );
  });

  it("writes the name on blur, and only when it changed", async () => {
    await render([host(), added()]);
    const field = nameField("gitlab.contoso.dev");

    await typeInto(field, "Contoso");
    // Every write is followed by a re-read; stand in for main having stored it.
    rows = [host(), added({ label: "Contoso" })];
    await blur(field);
    expect(writes).toEqual([
      { forgeHosts: { "gitlab.contoso.dev": { label: "Contoso" } } }
    ]);

    // A second blur with nothing typed must not re-send: a write re-reads the
    // whole host list, and tabbing through the pane would do it on every row.
    await blur(nameField("gitlab.contoso.dev"));
    expect(writes).toHaveLength(1);
  });

  it("writes on Enter without leaving the field", async () => {
    await render([host(), added()]);
    const field = nameField("gitlab.contoso.dev");
    await typeInto(field, "Contoso");
    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(writes).toEqual([
      { forgeHosts: { "gitlab.contoso.dev": { label: "Contoso" } } }
    ]);
  });

  it("sends the empty string to clear a name, not nothing at all", async () => {
    // Main merges into the stored entry, so omitting the field would keep the
    // old name and the cleared box would silently do nothing.
    await render([host(), added({ label: "Contoso" })]);
    const field = nameField("gitlab.contoso.dev");
    expect(field.value).toBe("Contoso");

    await typeInto(field, "");
    await blur(field);
    expect(writes).toEqual([
      { forgeHosts: { "gitlab.contoso.dev": { label: "" } } }
    ]);
  });

  it("restores the stored name on Escape", async () => {
    await render([host(), added({ label: "Contoso" })]);
    const field = nameField("gitlab.contoso.dev");
    await typeInto(field, "half-typed");
    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(field.value).toBe("Contoso");
    expect(writes).toEqual([]);
  });

  it("shows the stored form of a name it just sent", async () => {
    // Main trims and caps what it stores, and the write is followed by a
    // re-read. The field has to land on what was STORED, not on what was
    // typed, or the next blur sends the untrimmed text all over again.
    await render([host(), added()]);
    const field = nameField("gitlab.contoso.dev");
    await typeInto(field, "  Contoso  ");
    rows = [host(), added({ label: "Contoso" })];
    await blur(field);
    expect(nameField("gitlab.contoso.dev").value).toBe("Contoso");
    await blur(nameField("gitlab.contoso.dev"));
    expect(writes).toHaveLength(1);
  });
});

describe("Settings → Forges — adding a host by hand", () => {
  it("offers one button per product, because the product is chosen not guessed", async () => {
    await render();

    expect(button("Add GitHub Enterprise…")).toBeTruthy();
    expect(button("Add GitLab instance…")).toBeTruthy();
    // The rule this UI exists to uphold, said where the user is deciding.
    expect(container.textContent).toContain(
      "You name the instance. Nothing is inferred from a hostname, and no ssh remote ever appears here on its own."
    );
    // And each button sits in its own product's section, which is what lets
    // the row sub-lines stop repeating the product on every host.
    expect(section("GitHub").textContent).toContain("Add GitHub Enterprise…");
    expect(section("GitLab").textContent).toContain("Add GitLab instance…");
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
    forges = () => statuses(false);
    await render([]);

    // Each product says which CLI is not signed in, in its own section. Both
    // sentences are built from the registry, so a third product gets a third
    // accurate one — where a single shared line has no three-product form at
    // all: it was "Neither gh nor glab", then "No forge CLI (gh, glab)", and
    // neither could say which of them the reader needs to go and fix.
    expect(section("GitHub").textContent).toContain(
      "gh is not signed in to a GitHub host"
    );
    expect(section("GitLab").textContent).toContain(
      "glab is not signed in to a GitLab host"
    );
    expect(container.textContent).not.toContain("Neither");
    expect(container.textContent).not.toContain("No forge CLI");
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
      root.render(<ForgesSettings saving={false} />);
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

describe("Settings → Forges — removing a hand-added host", () => {
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
    expect(container.textContent).not.toContain("added by you");
    // And it gets the explanation `sourceNote` exists to give — including the
    // one thing "off" does NOT stop, since a switch that overpromises is the
    // same lie as one that still shells out.
    expect(container.textContent).toContain("PwrGit reads nothing from this host");
    expect(container.textContent).toContain("Only the sign-in check");
  });

  it("explains an env-pinned switch on a hand-added host", async () => {
    // Every config row used to take the "Added by you" branch, which made
    // `sourceNote` unreachable — so a switch that cannot move said nothing.
    await render([added({ enabled: false, enabledSource: "env" })]);

    expect(rowFor("gitlab.contoso.dev").textContent).toContain("added by you");
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

describe("Settings → Forges — one section per product", () => {
  it("puts each host under its own product, never in one interleaved list", async () => {
    // Sorted by hostname, main's order interleaves the two products — which is
    // exactly what the flat list used to render, directly above a card that
    // separated them.
    await render([
      added({ host: "ghe.contoso.dev", kind: "github", cli: "gh" }),
      host({ host: "github.com" }),
      host({ host: "gitlab.com", kind: "gitlab", cli: "glab" }),
      added({ host: "gitlab.contoso.dev" })
    ]);

    const hostsIn = (product: string): string[] =>
      [...section(product).querySelectorAll(".settings-field__label > span:first-child")]
        .map((node) => node.textContent ?? "")
        .filter((text) => text.includes("."));

    expect(hostsIn("GitHub")).toEqual(["ghe.contoso.dev", "github.com"]);
    expect(hostsIn("GitLab")).toEqual(["gitlab.com", "gitlab.contoso.dev"]);
  });

  it("stops repeating the product on every row, because the section says it", async () => {
    await render([host({ host: "github.com", account: "octo-dev" })]);

    const row = section("GitHub").querySelector(".settings-field__sub");
    expect(row?.textContent).toBe("signed in as octo-dev");
    // The old sub-line was "GitHub · signed in as octo-dev", which only existed
    // because a row could not otherwise say which product it belonged to.
    expect(row?.textContent).not.toContain("GitHub");
  });

  it("gives a product with no hosts its own section anyway", async () => {
    // The state this split exists for: the section is where a signed-out
    // product names its own CLI, and it cannot do that from inside a list of
    // the other product's hosts.
    forges = () => statuses(false);
    await render([host({ host: "github.com" })]);

    expect(section("GitLab").textContent).toContain(
      "glab is not signed in to a GitLab host"
    );
    expect(section("GitLab").textContent).toContain("Add GitLab instance…");
  });

  it("draws its sections from the product list rather than naming products", async () => {
    // The guarantee behind "a third product is a row in FORGE_KINDS": every
    // kind gets a section, and no more than the kinds get one.
    await render([]);

    const titles = [...container.querySelectorAll(".settings-panel__title")].map(
      (node) => node.textContent
    );
    expect(titles).toEqual(FORGE_KINDS.map((kind) => forgeProduct(kind).label));
  });

  it("refuses a duplicate against every product's hosts, not just this one's", async () => {
    // The add dialog is per product, but a hostname is global: letting GitLab
    // claim a host `gh` already reports would rewrite its product and route
    // that instance at the wrong CLI.
    await render([host({ host: "github.com" })]);

    await add("Add GitLab instance…", "github.com");

    expect(writes).toEqual([]);
    expect(alertIn(dialog())).toContain("github.com is already on the list.");
  });
});
