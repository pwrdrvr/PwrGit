// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FORGE_KINDS,
  forgeCapabilities,
  forgeInstall,
  forgeProduct,
  type ForgeKind,
  type ForgeStatus
} from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  copyText: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));
vi.mock("../../lib/copyText", () => ({ copyText: mocks.copyText }));

import { ForgesStep, arrivalOrder, initialSelection } from "./ForgesStep";

function status(
  kind: ForgeKind,
  over: Partial<Pick<ForgeStatus, "installed" | "loggedIn">> = {}
): ForgeStatus {
  return {
    kind,
    cli: forgeProduct(kind).cli,
    installed: false,
    loggedIn: false,
    capabilities: forgeCapabilities(kind),
    hosts: [],
    ...over
  };
}

const NOTHING_INSTALLED = FORGE_KINDS.map((kind) => status(kind));
/** GitHub connected, GitLab signed out, GitCafe missing. */
const MIXED = [
  status("github", { installed: true, loggedIn: true }),
  status("gitlab", { installed: true }),
  status("gitcafe")
];

let container: HTMLDivElement;
let root: Root;

function setPlatform(platform: string): void {
  (window as unknown as { pwrgit: { platform: string } }).pwrgit = { platform };
}

function text(): string {
  return container.textContent ?? "";
}

function panelText(): string {
  return container.querySelector('[role="tabpanel"]')?.textContent ?? "";
}

function commands(): string[] {
  return [...container.querySelectorAll(".onboarding-wizard__well-cmd")].map(
    (e) => e.textContent ?? ""
  );
}

function tabs(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
}

/** The strip as the reader sees it: name and state word, in order. */
function strip(): string[] {
  return tabs().map(
    (t) =>
      `${t.querySelector(".onboarding-wizard__lens-name")?.textContent} ${t.querySelector(".onboarding-wizard__lens-state")?.textContent}`
  );
}

function selectedTab(): string | undefined {
  return tabs()
    .find((t) => t.getAttribute("aria-selected") === "true")
    ?.querySelector(".onboarding-wizard__lens-name")?.textContent ?? undefined;
}

function tab(kind: ForgeKind): HTMLButtonElement {
  const found = tabs().find((t) =>
    t.getAttribute("aria-label")?.startsWith(`${forgeProduct(kind).label}:`)
  );
  if (found === undefined) throw new Error(`no tab for ${kind}`);
  return found;
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (b) =>
      (b.textContent ?? "").trim().startsWith(label) ||
      b.getAttribute("aria-label") === label
  );
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found as HTMLButtonElement;
}

async function select(kind: ForgeKind): Promise<void> {
  await act(async () => {
    tab(kind).click();
  });
}

/** Re-render in place: the same visit, so the strip keeps its order. */
async function mount(forges: ForgeStatus[] | undefined): Promise<void> {
  await act(async () => {
    root.render(<ForgesStep forges={forges} />);
  });
}

beforeEach(() => {
  mocks.dispatch.mockReset();
  mocks.dispatch.mockResolvedValue({ ok: true, value: null });
  mocks.copyText.mockReset();
  mocks.copyText.mockResolvedValue(undefined);
  setPlatform("darwin");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("arrivalOrder / initialSelection", () => {
  it("puts every detected forge first, each group in registry order", () => {
    const forges = [
      status("github"),
      status("gitlab"),
      status("gitcafe", { installed: true, loggedIn: true })
    ];
    expect(arrivalOrder(forges)).toEqual(["gitcafe", "github", "gitlab"]);
    expect(arrivalOrder(MIXED)).toEqual(["github", "gitlab", "gitcafe"]);
  });

  it("selects the first forge that needs something, else the first chip", () => {
    expect(initialSelection(arrivalOrder(MIXED), MIXED)).toBe("gitlab");
    const allConnected = FORGE_KINDS.map((kind) =>
      status(kind, { installed: true, loggedIn: true })
    );
    expect(initialSelection(arrivalOrder(allConnected), allConnected)).toBe(
      "github"
    );
  });
});

describe("ForgesStep", () => {
  it("shows one chip per forge and one panel, for the selected forge only", async () => {
    await mount(NOTHING_INSTALLED);
    expect(strip()).toEqual([
      "GitHub Not installed",
      "GitLab Not installed",
      "GitCafe Not installed"
    ]);
    expect(selectedTab()).toBe("GitHub");
    expect(commands()).toEqual(["brew install gh"]);
    expect(text()).toContain("Uses Homebrew.");
  });

  it.each(["darwin", "win32", "linux"])(
    "offers this machine's install commands on %s, from the registry",
    async (platform) => {
      setPlatform(platform);
      await mount(NOTHING_INSTALLED);
      for (const kind of FORGE_KINDS) {
        await select(kind);
        expect(commands()).toEqual([...forgeInstall(kind, platform).steps]);
      }
    }
  );

  it("numbers GitCafe's two steps", async () => {
    await mount(NOTHING_INSTALLED);
    await select("gitcafe");
    expect(commands()).toEqual([
      "curl -fsSL https://bun.com/install | bash",
      "bun i -g @gitcafe/cli"
    ]);
    expect(
      [...container.querySelectorAll(".onboarding-wizard__well-step")].map(
        (e) => e.textContent
      )
    ).toEqual(["1", "2"]);
  });

  it("opens the vendor's guide through main, not a renderer link", async () => {
    setPlatform("linux");
    await mount(NOTHING_INSTALLED);
    await act(async () => {
      button("Linux packages").click();
    });
    expect(mocks.dispatch).toHaveBeenCalledWith("shell:openExternal", {
      url: forgeInstall("github", "linux").guideUrl
    });
  });

  it("tells Windows users to reopen PwrGit on a winget forge's panel only", async () => {
    setPlatform("win32");
    await mount(NOTHING_INSTALLED);
    expect(panelText()).toContain("Reopen PwrGit after installing gh.");
    // GitCafe is found through ~/.bun/bin without a relaunch.
    await select("gitcafe");
    expect(text()).not.toContain("Reopen PwrGit");
  });

  it("never shows the relaunch note off Windows", async () => {
    await mount(NOTHING_INSTALLED);
    expect(text()).not.toContain("Reopen PwrGit");
  });

  it("sorts detected forges first and opens on the first that needs something", async () => {
    await mount(MIXED);
    await act(async () => {}); // the arrival probe settles
    expect(strip()).toEqual([
      "GitHub Connected",
      "GitLab Signed out",
      "GitCafe Not installed"
    ]);
    expect(selectedTab()).toBe("GitLab");
  });

  it("sorts on the arrival probe's answer, not the stale snapshot it arrived with", async () => {
    const fresh = [
      status("github"),
      status("gitlab", { installed: true }),
      status("gitcafe")
    ];
    let finish: () => void = () => {};
    mocks.dispatch.mockImplementation((command: string) =>
      command === "forge:status"
        ? Promise.resolve({ ok: true, value: { forges: fresh } })
        : new Promise((resolve) => {
            finish = () => resolve({ ok: true, value: null });
          })
    );
    // The wizard's snapshot predates glab's install, and no push corrects it:
    // the step must sort on what main says once the forced probe is done.
    await mount(NOTHING_INSTALLED);
    await act(async () => finish());
    expect(tabs().map((t) => t.getAttribute("aria-label"))).toEqual([
      "GitLab: Not installed",
      "GitHub: Not installed",
      "GitCafe: Not installed"
    ]);
    expect(selectedTab()).toBe("GitLab");
    expect(mocks.dispatch).toHaveBeenCalledWith("forge:status", undefined);
  });

  it("labels the panel by its selected tab, and points to Settings for later", async () => {
    await mount(NOTHING_INSTALLED);
    const panel = container.querySelector('[role="tabpanel"]');
    expect(panel?.getAttribute("aria-labelledby")).toBe(tab("github").id);
    expect(tab("github").getAttribute("aria-controls")).toBe(panel?.id);
    expect(text()).toContain("all of this stays in Settings › Forges.");
  });

  it("says 'these' under GitCafe's two commands and 'it' under one", async () => {
    await mount(NOTHING_INSTALLED);
    expect(panelText()).toContain("Run it in a terminal");
    await select("gitcafe");
    expect(panelText()).toContain("Run these in a terminal");
  });

  it("keeps the strip's order and the selection for the whole visit", async () => {
    await mount(NOTHING_INSTALLED);
    await select("gitlab");
    // gh is installed and glab signed in from a terminal mid-visit.
    await mount([
      status("github", { installed: true }),
      status("gitlab", { installed: true, loggedIn: true }),
      status("gitcafe")
    ]);
    expect(strip()).toEqual([
      "GitHub Signed out",
      "GitLab Connected",
      "GitCafe Not installed"
    ]);
    expect(selectedTab()).toBe("GitLab");
    expect(panelText()).toContain(
      "glab is installed and signed in. PwrGit reads merge requests through it."
    );
  });

  it("moves along the strip with the arrow keys, as one tab stop", async () => {
    await mount(NOTHING_INSTALLED);
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    await act(async () => {
      tab("github").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
      );
    });
    expect(selectedTab()).toBe("GitLab");
    expect(document.activeElement).toBe(tab("gitlab"));
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    await act(async () => {
      tab("gitlab").dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true })
      );
    });
    expect(selectedTab()).toBe("GitCafe");
  });

  it("makes the sign-in command copyable, and says so for two seconds", async () => {
    vi.useFakeTimers();
    await mount([
      status("github", { installed: true }),
      status("gitlab", { installed: true, loggedIn: true }),
      status("gitcafe")
    ]);
    expect(selectedTab()).toBe("GitHub");
    expect(commands()).toEqual(["gh auth login"]);

    await act(async () => {
      button("Copy gh auth login").click();
    });
    expect(mocks.copyText).toHaveBeenCalledWith("gh auth login");
    expect(button("Copy gh auth login").textContent).toBe("Copied");

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(button("Copy gh auth login").textContent).toBe("Copy");
  });

  it("only says to run something in a terminal beside a command", async () => {
    await mount(NOTHING_INSTALLED);
    expect(panelText()).toContain("Run it in a terminal");
    const allConnected = FORGE_KINDS.map((kind) =>
      status(kind, { installed: true, loggedIn: true })
    );
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(allConnected);
    expect(panelText()).toContain("gh is installed and signed in.");
    expect(text()).not.toContain("Run it in a terminal");
  });

  it("forces a probe on arrival, so stepping back and forward sees an install", async () => {
    await mount(NOTHING_INSTALLED);
    expect(mocks.dispatch).toHaveBeenCalledWith("forge:hosts", { refresh: true });
  });

  it("forces a probe from Re-check every time, however recent the last", async () => {
    await mount(NOTHING_INSTALLED);
    mocks.dispatch.mockClear();
    await act(async () => {
      button("Re-check").click();
    });
    expect(mocks.dispatch).toHaveBeenCalledWith("forge:hosts", { refresh: true });
  });

  it("forces a probe on window focus, at most once per five seconds", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      await mount(NOTHING_INSTALLED);
      const forced = () =>
        mocks.dispatch.mock.calls.filter(([command]) => command === "forge:hosts")
          .length;
      expect(forced()).toBe(1);

      // Focus straight after arriving: the arrival probe already answered it.
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(forced()).toBe(1);

      now.mockReturnValue(1_005_000);
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(forced()).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  it("shows Checking… on chips that need something while a forced probe runs", async () => {
    let finish: () => void = () => {};
    mocks.dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, value: null });
        })
    );
    // Arriving starts the probe; it is still running when the user looks.
    await mount(MIXED);
    expect(strip()).toEqual([
      "GitHub Connected",
      "GitLab Checking…",
      "GitCafe Checking…"
    ]);
    expect(button("Checking…").getAttribute("aria-busy")).toBe("true");
    // A second request while one is in flight is the same request.
    await act(async () => {
      button("Checking…").click();
      window.dispatchEvent(new Event("focus"));
    });
    expect(
      mocks.dispatch.mock.calls.filter(([command]) => command === "forge:hosts")
    ).toHaveLength(1);

    await act(async () => finish());
    expect(strip()).toEqual([
      "GitHub Connected",
      "GitLab Signed out",
      "GitCafe Not installed"
    ]);
  });

  it("keeps asking main while open, so a terminal install reaches the step", async () => {
    vi.useFakeTimers();
    await mount(NOTHING_INSTALLED);
    // Arrival reads it once to sort the strip; the tick is what comes after.
    mocks.dispatch.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(29_999);
    });
    expect(mocks.dispatch).not.toHaveBeenCalledWith("forge:status", undefined);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.dispatch).toHaveBeenCalledWith("forge:status", undefined);
  });
});
