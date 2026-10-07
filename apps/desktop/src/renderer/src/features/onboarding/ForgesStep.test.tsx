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

import { ForgesStep } from "./ForgesStep";

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

let container: HTMLDivElement;
let root: Root;

function setPlatform(platform: string): void {
  (window as unknown as { pwrgit: { platform: string } }).pwrgit = { platform };
}

function text(): string {
  return container.textContent ?? "";
}

function commands(): string[] {
  return [...container.querySelectorAll(".onboarding-wizard__well-cmd")].map(
    (e) => e.textContent ?? ""
  );
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

describe("ForgesStep", () => {
  it.each(["darwin", "win32", "linux"])(
    "offers this machine's install commands on %s, from the registry",
    async (platform) => {
      setPlatform(platform);
      await mount(NOTHING_INSTALLED);
      expect(commands()).toEqual(
        FORGE_KINDS.flatMap((kind) => [...forgeInstall(kind, platform).steps])
      );
    }
  );

  it("names the macOS package manager and numbers GitCafe's two steps", async () => {
    await mount(NOTHING_INSTALLED);
    expect(commands()).toEqual([
      "brew install gh",
      "brew install glab",
      "curl -fsSL https://bun.com/install | bash",
      "bun i -g @gitcafe/cli"
    ]);
    expect(text()).toContain("Uses Homebrew.");
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

  it("tells Windows users to reopen PwrGit only while a winget CLI is missing", async () => {
    setPlatform("win32");
    await mount(NOTHING_INSTALLED);
    expect(text()).toContain("Reopen PwrGit after installing gh or glab.");

    await mount([
      status("github", { installed: true }),
      status("gitlab", { installed: true, loggedIn: true }),
      status("gitcafe")
    ]);
    // GitCafe is found through ~/.bun/bin without a relaunch.
    expect(text()).not.toContain("Reopen PwrGit");
  });

  it("never shows the relaunch note off Windows", async () => {
    await mount(NOTHING_INSTALLED);
    expect(text()).not.toContain("Reopen PwrGit");
  });

  it("makes the sign-in command copyable, and says so for two seconds", async () => {
    vi.useFakeTimers();
    await mount([
      status("github", { installed: true }),
      status("gitlab", { installed: true, loggedIn: true }),
      status("gitcafe")
    ]);
    expect(commands()[0]).toBe("gh auth login");
    expect(text()).toContain("Signed out");
    expect(text()).toContain("glab is installed and signed in.");

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

  it("only says to run commands while a row has some", async () => {
    await mount(NOTHING_INSTALLED);
    expect(text()).toContain("Run these in a terminal.");
    await mount(
      FORGE_KINDS.map((kind) => status(kind, { installed: true, loggedIn: true }))
    );
    expect(text()).not.toContain("Run these in a terminal.");
    expect(text()).toContain("All of it lives in Settings › Forges afterwards.");
  });

  it("shows Checking… on blocked rows while a forced probe runs", async () => {
    let finish: () => void = () => {};
    mocks.dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, value: null });
        })
    );
    // Arriving starts the probe; it is still running when the user looks.
    await mount([
      status("github", { installed: true, loggedIn: true }),
      status("gitlab"),
      status("gitcafe")
    ]);
    const chips = () =>
      [...container.querySelectorAll(".onboarding-wizard__forge-chip")].map(
        (e) => e.textContent
      );
    expect(chips()).toEqual(["Connected", "Checking…", "Checking…"]);
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
    expect(chips()).toEqual(["Connected", "Not installed", "Not installed"]);
  });

  it("keeps asking main while open, so a terminal install reaches the step", async () => {
    vi.useFakeTimers();
    await mount(NOTHING_INSTALLED);
    expect(mocks.dispatch).not.toHaveBeenCalledWith("forge:status", undefined);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(mocks.dispatch).toHaveBeenCalledWith("forge:status", undefined);
  });
});
