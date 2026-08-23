// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type SubmoduleSnapshot } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
const subscribeMock = vi.hoisted(() => vi.fn(() => vi.fn()));
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: subscribeMock
}));

import { SubmodulePanel } from "./SubmodulePanel";

const SNAPSHOT: SubmoduleSnapshot = {
  truncated: false,
  issues: [],
  submodules: [
    {
      name: "api",
      path: "modules/api",
      depth: 0,
      pinnedCommit: "1111111111111111111111111111111111111111",
      indexCommit: "2222222222222222222222222222222222222222",
      checkedOutCommit: "3333333333333333333333333333333333333333",
      checkoutState: "checked_out",
      relation: "diverged_from_pin",
      dirty: true,
      detached: true,
      pinnedTags: ["v1.2.0"],
      configuredUrl: "ssh://git@example.test/api.git",
      initializedUrl: "ssh://old.example.test/api.git",
      configuredBranch: "release/1.2",
      issues: [
        {
          code: "url_changed",
          severity: "warning",
          message: "The initialized URL differs from the current .gitmodules URL.",
          remedy: "Review the new endpoint, then run submodule sync before fetching."
        }
      ]
    },
    {
      name: "docs",
      path: "modules/docs",
      depth: 0,
      pinnedCommit: "4444444444444444444444444444444444444444",
      indexCommit: "4444444444444444444444444444444444444444",
      checkoutState: "deinitialized",
      relation: "unknown",
      dirty: null,
      detached: null,
      pinnedTags: [],
      configuredUrl: "../docs.git",
      issues: [
        {
          code: "checkout_deinitialized",
          severity: "warning",
          message: "This submodule was deinitialized; its Git data is still retained locally.",
          remedy: "Reinitialize it from the parent after reviewing the configured URL."
        }
      ]
    }
  ]
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  dispatchMock.mockResolvedValue(ok(SNAPSHOT));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("SubmodulePanel", () => {
  it("renders authoritative pins separately from checkout and .gitmodules hints", async () => {
    const onConcernChange = vi.fn();
    await act(async () => {
      root.render(
        <SubmodulePanel
          worktreeId="worktree-1"
          onConcernChange={onConcernChange}
        />
      );
    });

    expect(dispatchMock).toHaveBeenCalledWith("submodules:list", {
      worktreeId: "worktree-1"
    });
    expect(container.textContent).toContain("Submodules");
    expect(container.textContent).toContain("modules/api");
    expect(container.textContent).toContain("Parent pin");
    expect(container.textContent).toContain("11111111");
    expect(container.textContent).toContain("Next pin");
    expect(container.textContent).toContain("22222222");
    expect(container.textContent).toContain("33333333");
    expect(container.textContent).toContain("v1.2.0");
    expect(container.textContent).toContain("Dirty");
    expect(container.textContent).toContain("Diverged");
    expect(container.textContent).toContain("detached HEAD");
    expect(container.textContent).toContain("release/1.2");
    expect(container.textContent).toContain("ssh://git@example.test/api.git");
    expect(container.textContent).toContain("ssh://old.example.test/api.git");
    expect(container.textContent).toContain("run submodule sync");
    expect(container.textContent).toContain(
      "Pins come from Git’s 160000 entries"
    );
    expect(onConcernChange).toHaveBeenLastCalledWith(true);
  });

  it("keeps an actionable deinitialized failure visible without inventing checkout state", async () => {
    await act(async () => {
      root.render(<SubmodulePanel worktreeId="worktree-1" />);
    });

    expect(container.textContent).toContain("modules/docs");
    expect(container.textContent).toContain("Deinitialized");
    expect(container.textContent).toContain("44444444");
    expect(container.textContent).toContain("Reinitialize it from the parent");
  });

  it("disappears after a successful scan finds no submodules or parent issues", async () => {
    dispatchMock.mockResolvedValue(
      ok({ submodules: [], truncated: false, issues: [] })
    );
    await act(async () => {
      root.render(<SubmodulePanel worktreeId="worktree-1" />);
    });
    expect(container.textContent).toBe("");
  });

  it("refreshes deliberately without mutating the checkout", async () => {
    await act(async () => {
      root.render(<SubmodulePanel worktreeId="worktree-1" />);
    });
    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh submodules"]'
    );
    expect(refresh).not.toBeNull();
    await act(async () => refresh?.click());
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(
      dispatchMock.mock.calls.every(([command]) => command === "submodules:list")
    ).toBe(true);
  });
});
