// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GENERAL_DEFAULTS, type AppSettingsSnapshot } from "@pwrgit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeneralSettings } from "./GeneralSettings";

vi.mock("./GitRuntimeSettings", () => ({ GitRuntimeSettings: () => null }));

let container: HTMLDivElement;
let root: Root;
const update = vi.fn();

beforeEach(() => {
  update.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(reflink: "off" | "on", seed: "off" | "on" = "off") {
  const snapshot = { general: GENERAL_DEFAULTS, worktreeReflink: reflink, worktreeSeedCargoTarget: seed } as AppSettingsSnapshot;
  await act(async () => root.render(<GeneralSettings
    saving={false}
    snapshot={snapshot}
    platform="darwin"
    onThemeChange={() => undefined}
    onDeveloperModeChange={() => undefined}
    onSearchAllProfilesChange={() => undefined}
    onSidebarTextSizeChange={() => undefined}
    onSidebarDensityChange={() => undefined}
    onWorktreeSharingChange={update}
  />));
}

function control(label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`missing control: ${label}`);
  return button;
}

describe("worktree sharing settings", () => {
  it("disables seeding while source sharing is off, even for stale seed state", async () => {
    await render("off", "on");
    const seed = control("Seed Cargo dependency builds");
    expect(seed.disabled).toBe(true);
    expect(seed.getAttribute("aria-checked")).toBe("false");
    await act(async () => seed.click());
    expect(update).not.toHaveBeenCalled();
    await act(async () => control("Share source files").click());
    expect(update).toHaveBeenCalledWith({ worktreeReflink: "on" });
  });

  it("allows seeding after source sharing is enabled", async () => {
    await render("on");
    expect(control("Seed Cargo dependency builds").disabled).toBe(false);
    await act(async () => control("Seed Cargo dependency builds").click());
    expect(update).toHaveBeenCalledWith({ worktreeSeedCargoTarget: "on" });
    await act(async () => control("Share source files").click());
    expect(update).toHaveBeenCalledWith({ worktreeReflink: "off" });
  });

  it("saves the optional executable override when leaving the field", async () => {
    await render("off");
    const input = container.querySelector<HTMLInputElement>('input[aria-label="pwrgit-share executable"]');
    if (!input) throw new Error("missing command input");
    input.value = " /fixture/pwrgit-share ";
    await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(update).toHaveBeenCalledWith({ worktreeShareCommand: "/fixture/pwrgit-share" });
  });

  it("explains fallback and safe dependency reuse without promising freed bytes", async () => {
    await render("off");
    expect(container.textContent).toContain("Supported filesystems share unchanged source files");
    expect(container.textContent).toContain("Other filesystems keep today’s normal Git checkout");
    expect(container.textContent).toContain("Share unchanged dependency builds when the CLI can verify safe reuse");
    expect(container.textContent).toContain("pwrgit-share 0.1.0 skips all Cargo seeding because safe reuse is not yet proven");
    expect(container.textContent).toContain("Build outputs that are not safe to reuse are compiled again");
    expect(container.textContent).not.toMatch(/freeing|\d+\s*GB/i);
  });
});
