// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, Repo } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  useForgeStatuses: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));
vi.mock("../settings/useForgeStatuses", () => ({
  useForgeStatuses: mocks.useForgeStatuses
}));

import { OnboardingWizard } from "./OnboardingWizard";

const PROFILE: Profile = {
  id: "personal",
  name: "Personal",
  email: "",
  mono: "P",
  roots: [],
  onboardingCompleted: false
};

let container: HTMLDivElement;
let root: Root;

function text(): string {
  return container.textContent ?? "";
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith(label)
  );
  if (found === undefined) throw new Error(`no button starting "${label}"`);
  return found as HTMLButtonElement;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
}

function railLabels(): string[] {
  return [...container.querySelectorAll(".onboarding-wizard__rail-label")].map(
    (e) => (e.textContent ?? "").trim()
  );
}

async function mount(
  overrides: Partial<Parameters<typeof OnboardingWizard>[0]> = {}
): Promise<{ onDismiss: ReturnType<typeof vi.fn> }> {
  const onDismiss = vi.fn();
  await act(async () => {
    root.render(
      <OnboardingWizard
        profile={PROFILE}
        repos={[]}
        isReplay={false}
        pickDirectories={vi.fn(async () => [])}
        onSetRoots={vi.fn(async () => undefined)}
        onSetIdentity={vi.fn(async () => undefined)}
        onDismiss={onDismiss}
        {...overrides}
      />
    );
  });
  return { onDismiss };
}

beforeEach(() => {
  mocks.dispatch.mockReset();
  mocks.dispatch.mockResolvedValue({
    ok: true,
    value: {
      name: "Dana Whitfield",
      email: "dana@example.com",
      conditionalDirs: []
    }
  });
  mocks.useForgeStatuses.mockReturnValue([]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("OnboardingWizard", () => {
  it("opens on Welcome, which is before the rail starts", async () => {
    await mount();
    expect(text()).toContain("Point PwrGit at your code");
    expect(container.querySelector(".onboarding-wizard__rail")).toBeNull();
  });

  it("seeds identity from git config, not from the profile's stored email", async () => {
    await mount();
    await click("Start");
    const inputs = [...container.querySelectorAll("input")];
    expect(inputs.map((i) => i.value)).toEqual([
      "Dana Whitfield",
      "dana@example.com"
    ]);
    expect(mocks.dispatch).toHaveBeenCalledWith("git:readIdentity", undefined);
  });

  it("walks Welcome → Done, relabelling the rail with the answers", async () => {
    await mount();
    await click("Start");
    expect(railLabels()).toEqual([
      "Identity",
      "Forges",
      "Repo folders",
      "Review"
    ]);

    await click("Continue");
    // Past Identity: the rail now reports the answer instead of the step name.
    expect(railLabels()[0]).toBe("Dana Whitfield");

    await click("Continue");
    await click("Choose folders");
    expect(text()).toContain("Which folders hold your repositories?");

    await click("Continue without folders");
    await click("See the result");
    expect(text()).toContain("No repositories yet.");
    expect(railLabels()[2]).toBe("None");
  });

  it("names the directories a conditional include re-points", async () => {
    mocks.dispatch.mockResolvedValue({
      ok: true,
      value: {
        name: "Dana Whitfield",
        email: "dana@example.com",
        conditionalDirs: ["~/work/"]
      }
    });
    await mount();
    await click("Start");
    expect(text()).toContain("sets a different identity for repositories under");
    expect(text()).toContain("~/work/");
  });

  it("blocks Continue on Identity until both fields are filled", async () => {
    mocks.dispatch.mockResolvedValue({
      ok: true,
      value: { name: null, email: null, conditionalDirs: [] }
    });
    await mount();
    await click("Start");
    expect(button("Continue").disabled).toBe(true);
  });

  it("Skip dismisses and persists completion — closing is not deferring", async () => {
    const { onDismiss } = await mount();
    await click("Skip setup");
    expect(onDismiss).toHaveBeenCalledWith(true);
  });

  it("a replay dismisses WITHOUT persisting, so the flag it never set stays", async () => {
    const { onDismiss } = await mount({ isReplay: true });
    await click("Skip setup");
    expect(onDismiss).toHaveBeenCalledWith(false);
  });

  it("teaches the scan's real limits before asking for a folder", async () => {
    await mount();
    await click("Start");
    await click("Continue");
    await click("Continue");
    const body = text();
    // The three facts that make "point it at your home folder" answerable.
    expect(body).toContain("five levels down");
    expect(body).toContain(".ssh");
    expect(body).toContain("reads folder names, not files");
    expect(body).toContain("node_modules");
  });

  it("warns when a home directory is added as a root", async () => {
    await mount({
      profile: { ...PROFILE, roots: ["/Users/dana"] },
      pickDirectories: vi.fn(async () => [])
    });
    await click("Start");
    await click("Continue");
    await click("Continue");
    await click("Choose folders");
    expect(text()).toContain("Adding your home folder works, and we would not");
  });

  it("Done describes the lenses rather than counting what a scan cannot know", async () => {
    const repo = {
      id: "r1",
      path: "/code/ledger-api",
      worktrees: [{ id: "w1" }, { id: "w2" }]
    } as unknown as Repo;
    await mount({ profile: { ...PROFILE, roots: ["/code"] }, repos: [repo] });
    await click("Start");
    await click("Continue");
    await click("Continue");
    await click("Choose folders");
    await click("Scan 1 folder");
    await click("See the result");
    expect(text()).toContain("1 repository, 2 worktrees, 1 folder.");
    // No Focused/Pinned/Behind counts — they are explained, not asserted.
    expect(text()).toContain("Empty until you start working");
    expect(text()).toContain("a scan does not pin anything for you");
  });
});
