// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type AgentAccessSnapshot, type McpAgentRole } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));

import { AgentAccessSection } from "./AgentAccessSection";

const roles: McpAgentRole[] = [
  {
    id: "builtin.local-reader",
    name: "Local Repository Reader",
    description: "",
    builtIn: true,
    permissions: ["repository.roots.read"],
    repositoryRoots: null
  },
  {
    id: "builtin.live-status",
    name: "Live Forge Status",
    description: "",
    builtIn: true,
    permissions: ["repository.roots.read"],
    repositoryRoots: null
  }
];

function snapshot(patch: Partial<AgentAccessSnapshot> = {}): AgentAccessSnapshot {
  return {
    enabled: false,
    listening: false,
    mcpUrl: "http://127.0.0.1:51731/mcp",
    pending: [],
    ...patch
  };
}

function pendingSnapshot(clientName: string, pairingId: string): AgentAccessSnapshot {
  return snapshot({
    enabled: true,
    listening: true,
    pending: [
      {
        pairingId,
        clientName,
        createdAt: "2026-09-03T00:00:00.000Z",
        expiresAt: "2026-09-03T00:05:00.000Z"
      }
    ]
  });
}

let container: HTMLDivElement;
let root: Root;
const unsubscribe = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subscribe.mockReturnValue(unsubscribe);
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
    root.render(<AgentAccessSection roles={roles} />);
  });
}

function buttonNamed(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label
  );
}

describe("AgentAccessSection", () => {
  it("starts off, because an open endpoint is a standing grant", async () => {
    mocks.dispatch.mockResolvedValue(ok(snapshot()));
    await render();

    const toggle = container.querySelector("[role='switch']");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain(
      "PwrGit accepts no agent connections while this is off."
    );
    // Nothing about pending requests renders while the listener is off.
    expect(container.querySelector(".agent-access-pending")).toBeNull();
  });

  it("enables the listener through the command bus", async () => {
    mocks.dispatch.mockImplementation((name: string) =>
      name === "agentAccess:setEnabled"
        ? Promise.resolve(ok(snapshot({ enabled: true, listening: true })))
        : Promise.resolve(ok(snapshot()))
    );
    await render();

    await act(async () => {
      (container.querySelector("[role='switch']") as HTMLElement).click();
    });

    expect(mocks.dispatch).toHaveBeenCalledWith("agentAccess:setEnabled", {
      enabled: true
    });
    expect(container.textContent).toContain("reachable at");
  });

  it("approves a pending request with the selected role", async () => {
    mocks.dispatch.mockImplementation((name: string) =>
      name === "agentAccess:approvePairing"
        ? Promise.resolve(ok(snapshot({ enabled: true, listening: true })))
        : Promise.resolve(ok(pendingSnapshot("Claude Code", "pair_1")))
    );
    await render();

    expect(container.textContent).toContain("Claude Code");

    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "builtin.live-status";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      buttonNamed("Approve")?.click();
    });

    expect(mocks.dispatch).toHaveBeenCalledWith("agentAccess:approvePairing", {
      pairingId: "pair_1",
      roleId: "builtin.live-status"
    });
  });

  it("denies a request without minting a session", async () => {
    mocks.dispatch.mockImplementation((name: string) =>
      name === "agentAccess:denyPairing"
        ? Promise.resolve(ok(snapshot({ enabled: true, listening: true })))
        : Promise.resolve(ok(pendingSnapshot("Unknown agent", "pair_2")))
    );
    await render();

    await act(async () => {
      buttonNamed("Deny")?.click();
    });

    expect(mocks.dispatch).toHaveBeenCalledWith("agentAccess:denyPairing", {
      pairingId: "pair_2"
    });
    expect(mocks.dispatch).not.toHaveBeenCalledWith(
      "agentAccess:approvePairing",
      expect.anything()
    );
  });

  it("explains a listener that could not bind instead of showing it as on", async () => {
    mocks.dispatch.mockResolvedValue(
      ok(snapshot({ enabled: false, error: "listen EADDRINUSE" }))
    );
    await render();

    expect(container.textContent).toContain("could not start: listen EADDRINUSE");
    expect(container.querySelector("[role='switch']")?.getAttribute("aria-checked")).toBe(
      "false"
    );
  });

  it("defaults an approval to the narrowest useful role", async () => {
    mocks.dispatch.mockImplementation((name: string) =>
      name === "agentAccess:approvePairing"
        ? Promise.resolve(ok(snapshot({ enabled: true, listening: true })))
        : Promise.resolve(ok(pendingSnapshot("Some agent", "pair_3")))
    );
    await render();

    await act(async () => {
      buttonNamed("Approve")?.click();
    });

    expect(mocks.dispatch).toHaveBeenCalledWith("agentAccess:approvePairing", {
      pairingId: "pair_3",
      roleId: "builtin.local-reader"
    });
  });
});
