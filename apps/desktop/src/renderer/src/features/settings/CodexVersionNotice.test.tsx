// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_PROVIDER_SETTINGS, ok, type AiProviderSettings, type CodexProviderDiscovery } from "@pwrgit/shared";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn() }));
vi.mock("../../lib/pwrgit", () => mocks);
import { CodexVersionNotice } from "./CodexVersionNotice";

let root: Root;
let container: HTMLDivElement;
let settings: AiProviderSettings;
let discovery: CodexProviderDiscovery;
let changed: (snapshot: { profileId: string; settings: AiProviderSettings }) => void;
const copy = vi.fn(async () => undefined);

async function render(profileId: string | null = "personal") {
  await act(async () => { root.render(<CodexVersionNotice profileId={profileId} />); });
}
async function focus() {
  await act(async () => { window.dispatchEvent(new Event("focus")); });
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent === text || entry.getAttribute("aria-label") === text
  );
  expect(button, text).toBeDefined();
  await act(async () => { button!.click(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  settings = { ...DEFAULT_AI_PROVIDER_SETTINGS, enabled: true, consentAcceptedAt: "2026-09-01" };
  discovery = {
    candidates: [], resolvedPath: "/opt/homebrew/bin/codex", auth: null, refreshedAt: "now",
    versionAdvisory: {
      command: "/opt/homebrew/bin/codex", version: "0.153.4", minimumVersion: "0.159.2",
      installer: "homebrew", upgradeCommand: "brew upgrade --cask codex"
    }
  };
  mocks.subscribe.mockImplementation((_name, handler) => { changed = handler; return () => {}; });
  mocks.dispatch.mockImplementation(async (name, params) => {
    if (name === "aiProviders:read") return ok({ profileId: params.profileId, settings });
    if (name === "aiProviders:discoverCodex") return ok(discovery);
    return ok(null);
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("Codex launch notice", () => {
  it("does not discover or start Codex while AI is disabled", async () => {
    settings.enabled = false;
    await render();
    await focus();
    expect(mocks.dispatch.mock.calls.map(([name]) => name)).toEqual(["aiProviders:read"]);
    expect(container.textContent).toBe("");
  });

  it("offers model guidance, the actual upgrade command, and the profile's settings", async () => {
    await render();
    expect(container.textContent).toContain("0.159.2");
    expect(container.textContent).toContain("GPT-6 Sol and GPT-6.1 Sol");
    // One primary, the action this installer can take; Dismiss is text.
    const primary = container.querySelectorAll(".app-toast__button--primary");
    expect([...primary].map((entry) => entry.textContent)).toEqual(["Copy command"]);
    expect(container.textContent).toContain("PwrGit checks again when you switch back.");
    expect(container.textContent).not.toContain("Re-check");
    await click("Copy command");
    expect(copy).toHaveBeenCalledWith("brew upgrade --cask codex");
    expect(container.textContent).toContain("Copied");
    await click("AI Providers");
    expect(mocks.dispatch).toHaveBeenCalledWith("settings:open", {
      page: "ai-providers", sub: "codex", profileId: "personal"
    });
  });

  it("stays dismissed for the same runtime during this launch", async () => {
    await render();
    await click("Dismiss Codex update notice");
    await focus();
    await act(async () => { changed({ profileId: "personal", settings: { ...settings } }); });
    expect(container.textContent).toBe("");
  });

  it("rechecks on return from an update and removes a resolved warning", async () => {
    await render();
    delete discovery.versionAdvisory;
    await focus();
    expect(mocks.dispatch).toHaveBeenCalledWith("aiProviders:discoverCodex", { profileId: "personal", force: true });
    expect(container.textContent).toBe("");
  });

  it("handles enabling and disabling AI without restarting the window", async () => {
    settings.enabled = false;
    await render();
    await act(async () => { changed({ profileId: "personal", settings: { ...settings, enabled: true } }); });
    expect(container.textContent).toContain("Codex update recommended");
    await act(async () => { changed({ profileId: "personal", settings }); });
    expect(container.textContent).toBe("");
  });

  it("ignores changes from another profile", async () => {
    settings.enabled = false;
    await render();
    await act(async () => { changed({ profileId: "work", settings: { ...settings, enabled: true } }); });
    expect(mocks.dispatch).not.toHaveBeenCalledWith("aiProviders:discoverCodex", expect.anything());
  });

  it("ignores a stale probe when the window changes profiles", async () => {
    let resolve!: (value: ReturnType<typeof ok<CodexProviderDiscovery>>) => void;
    const pending = new Promise<ReturnType<typeof ok<CodexProviderDiscovery>>>((done) => { resolve = done; });
    mocks.dispatch.mockImplementation(async (name, params) => {
      if (name === "aiProviders:read") return ok({ profileId: params.profileId, settings });
      if (name === "aiProviders:discoverCodex") return params.profileId === "personal" ? pending : ok({ ...discovery, versionAdvisory: undefined });
      return ok(null);
    });
    await render();
    await render("work");
    await act(async () => { resolve(ok(discovery)); });
    expect(container.textContent).toBe("");
  });

  it("keeps an unknown installer actionable without inventing an update command", async () => {
    discovery.versionAdvisory = { command: "/opt/custom/codex", version: "0.153.4", minimumVersion: "0.159.2", installer: "unknown" };
    await render();
    expect(container.textContent).toContain("macOS, Windows, or Linux");
    expect(container.textContent).not.toContain("Copy command");
    await click("Codex releases ↗");
    expect(mocks.dispatch).toHaveBeenCalledWith("shell:openExternal", { url: "https://github.com/openai/codex/releases" });
  });

  it("shows copy failures and keeps the command visible", async () => {
    copy.mockRejectedValueOnce(new Error("Clipboard denied"));
    await render();
    await click("Copy command");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t copy");
    expect(container.textContent).toContain("brew upgrade --cask codex");
  });
});
