// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type MachineGitIdentity } from "@pwrgit/shared";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn() }));
vi.mock("../../lib/pwrgit", () => mocks);
import { GitIdentityNotice } from "./GitIdentityNotice";

const PROFILE = { name: "Personal", email: "rowan@vale.example" };
let root: Root;
let container: HTMLDivElement;
let machine: MachineGitIdentity;
const listeners = new Map<string, () => void>();

function missing(notice = true): MachineGitIdentity {
  return {
    outside: { kind: "missing", message: "no email was given and auto-detection is disabled" },
    config: [],
    globalFile: "/home/rowan/.gitconfig",
    notice
  };
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<GitIdentityNotice profile={PROFILE} />);
  });
}

async function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => {
    button!.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  machine = missing();
  mocks.subscribe.mockImplementation((name: string, handler: () => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  });
  mocks.dispatch.mockImplementation(async (name: string) => {
    if (name === "identity:machine") return ok(machine);
    return ok(null);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Git identity launch notice", () => {
  it("claims the notice, and says PwrGit's own commits are fine first", async () => {
    await render();
    expect(mocks.dispatch).toHaveBeenCalledWith("identity:machine", { claimNotice: true });
    expect(container.textContent).toContain("Git outside PwrGit has no name or email set.");
    expect(container.textContent).toContain("PwrGit commits as rowan@vale.example from your Personal profile.");
  });

  it("shows nothing in a window main did not give the notice to", async () => {
    machine = missing(false);
    await render();
    expect(container.textContent).toBe("");
  });

  it("names the guessed address on macOS", async () => {
    machine = {
      ...missing(),
      outside: { kind: "guessed", author: { name: "Rowan Vale", email: "rowan@Rowans-MBP.local" }, source: "system" }
    };
    await render();
    expect(container.textContent).toContain("Git outside PwrGit is guessing your email.");
    expect(container.textContent).toContain("rowan@Rowans-MBP.local");
  });

  it("says an address from $EMAIL reaches only shells that export it", async () => {
    machine = {
      ...missing(),
      outside: { kind: "guessed", author: { name: "Rowan Vale", email: "rowan@vale.example" }, source: "environment" }
    };
    await render();
    expect(container.textContent).toContain("Git outside PwrGit has no identity of its own.");
    expect(container.textContent).toContain("a shell that exports EMAIL");
    expect(container.textContent).not.toContain("computer’s name");
  });

  it("goes to Settings › Profiles › Git outside PwrGit", async () => {
    await render();
    await click("Set up in Settings…");
    expect(mocks.dispatch).toHaveBeenCalledWith("settings:open", { page: "profiles", sub: "git-identity" });
  });

  it("tells main when it is put off, so no other window raises it", async () => {
    await render();
    await click("Not now");
    expect(mocks.dispatch).toHaveBeenCalledWith("identity:dismissNotice", undefined);
    expect(container.textContent).toBe("");
  });

  it("withdraws once Git has an identity, without being dismissed", async () => {
    await render();
    machine = {
      ...missing(false),
      outside: {
        kind: "configured",
        author: { name: "Rowan Vale", email: "rowan@vale.example" },
        committer: { name: "Rowan Vale", email: "rowan@vale.example" }
      }
    };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(container.textContent).toBe("");
    expect(mocks.dispatch).not.toHaveBeenCalledWith("identity:dismissNotice", undefined);
  });
});
