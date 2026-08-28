// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PWRGIT_LINKS,
  err,
  ok,
  pwrGitError,
  type AppIdentity
} from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  copyText: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));
vi.mock("../../lib/copyText", () => ({ copyText: mocks.copyText }));

import { AboutSettings } from "./AboutSettings";

const IDENTITY: AppIdentity = {
  name: "PwrGit",
  version: "1.2.0-alpha.7",
  release: { train: "beta", channel: "prerelease" },
  buildType: "packaged",
  platform: { name: "macOS", version: "15.6.1", arch: "arm64" },
  electronVersion: "41.0.0",
  diagnosticsText: [
    "PwrGit 1.2.0-alpha.7",
    "Release: Beta / Prerelease",
    "Build: Packaged",
    "Platform: macOS 15.6.1 (arm64)",
    "Electron: 41.0.0"
  ].join("\n")
};

let container: HTMLDivElement;
let root: Root;

function defaultDispatch(name: string) {
  if (name === "app:readIdentity") return Promise.resolve(ok(IDENTITY));
  return Promise.resolve(ok(null));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockImplementation(defaultDispatch);
  mocks.copyText.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<AboutSettings />);
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return match;
}

describe("AboutSettings", () => {
  it("renders accessible build, product, support, and attribution entry points", async () => {
    await render();

    expect(mocks.dispatch).toHaveBeenCalledWith("app:readIdentity", undefined);
    expect(
      Array.from(container.querySelectorAll("h2"), (heading) =>
        heading.textContent?.trim()
      )
    ).toEqual(["This build", "Resources", "Help and reporting", "Attribution"]);
    expect(container.textContent).toContain("v1.2.0-alpha.7");
    expect(container.textContent).toContain("Beta · Prerelease");
    expect(container.textContent).toContain("Packaged application");
    expect(container.textContent).toContain("macOS 15.6.1 (arm64)");
    expect(container.textContent).toContain("Electron 41.0.0");
    expect(button("Open documentation").type).toBe("button");
    expect(button("Open issue tracker").type).toBe("button");
    expect(button("Open private reporting guidance").type).toBe("button");
    expect(button("Copy Security reporting address")).toBeDefined();

    const support = container.querySelector(
      "section[aria-label='Help and reporting']"
    );
    expect(support?.textContent).toContain("Do not post vulnerabilities publicly");
    expect(support?.textContent).toContain("never include secrets");
    expect(support?.textContent).toContain(PWRGIT_LINKS.security);
  });

  it("copies a sanitized diagnostics identity with live confirmation", async () => {
    await render();

    await act(async () => button("Copy diagnostics identity").click());

    expect(mocks.copyText).toHaveBeenCalledWith(IDENTITY.diagnosticsText);
    const status = container.querySelector("[role='status']");
    expect(status?.textContent).toBe("Diagnostics identity copied.");
  });

  it("opens canonical URLs through the command bus and offers offline recovery", async () => {
    mocks.dispatch.mockImplementation((name: string) => {
      if (name === "app:readIdentity") return Promise.resolve(ok(IDENTITY));
      if (name === "shell:openExternal") {
        return Promise.resolve(
          err(
            pwrGitError(
              "unknown",
              "external_open_failed",
              "Default browser unavailable."
            )
          )
        );
      }
      return Promise.resolve(ok(null));
    });
    await render();

    await act(async () => button("Open documentation").click());

    expect(mocks.dispatch).toHaveBeenCalledWith("shell:openExternal", {
      url: PWRGIT_LINKS.documentation
    });
    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Copy the address");
    expect(alert?.textContent).toContain("when you’re online");
    expect(container.textContent).toContain(PWRGIT_LINKS.documentation);

    await act(async () => button("Copy Documentation address").click());
    expect(mocks.copyText).toHaveBeenCalledWith(PWRGIT_LINKS.documentation);
  });

  it("keeps resources usable and offers retry when identity loading fails", async () => {
    mocks.dispatch
      .mockResolvedValueOnce(
        err(pwrGitError("unknown", "identity_failed", "runtime unavailable"))
      )
      .mockResolvedValueOnce(ok(IDENTITY));
    await render();

    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Build details are unavailable"
    );
    expect(button("Open documentation")).toBeDefined();

    await act(async () => button("Retry").click());
    expect(container.textContent).toContain("v1.2.0-alpha.7");
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  });
});
