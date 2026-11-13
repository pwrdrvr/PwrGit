// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposedFolder, Profile, Repo, RepoSearchResult } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
  useForgeStatuses: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));
vi.mock("../settings/useForgeStatuses", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../settings/useForgeStatuses")>()),
  useForgeStatuses: mocks.useForgeStatuses
}));

import { OnboardingWizard } from "./OnboardingWizard";

const PROFILE: Profile = {
  id: "personal",
  name: "Personal",
  email: "",
  mono: "P",
  roots: [],
  onboardingCompleted: false,
  showInMenu: true
};

const SUGGESTED = ["projects", "github", "git"].map((name) => ({
  name,
  path: `/Users/dana/${name}`,
  display: `~/${name}`,
  exists: name === "github"
}));

const EMPTY_SEARCH: RepoSearchResult = {
  home: "/Users/dana",
  folders: [],
  foldersOpened: 40,
  stoppedEarly: null,
  includedProtected: false,
  protectedSkipped: ["/Users/dana/Documents"],
  refused: [],
  cloudSkipped: [],
  protectedAskFirst: true,
  homeIsRepository: false
};

function folder(path: string, repos: string[], extra: Partial<ProposedFolder> = {}): ProposedFolder {
  return {
    path,
    display: path.replace("/Users/dana", "~"),
    isRepository: false,
    repositories: repos.map((name) => ({
      key: `${path}/${name}/.git`,
      name,
      checkouts: [`${path}/${name}`],
      primaryFound: true,
      indexable: true
    })),
    worktreeCount: 0,
    ownerFolders: 0,
    checked: true,
    selectable: true,
    note: null,
    ...extra
  };
}

let identity: { name: string | null; email: string | null; conditionalDirs: string[] };
let search: RepoSearchResult;
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
  identity = {
    name: "Dana Whitfield",
    email: "dana@example.com",
    conditionalDirs: []
  };
  search = EMPTY_SEARCH;
  mocks.dispatch.mockImplementation(async (name: string, req: unknown) => {
    switch (name) {
      case "git:readIdentity":
        return { ok: true, value: identity };
      case "profile:suggestedRoots":
        return { ok: true, value: SUGGESTED };
      case "repo:searchHome":
        return { ok: true, value: search };
      case "repo:stopSearch":
        return { ok: true, value: null };
      case "profile:createRoot": {
        const root = (req as { root: { kind: string; name?: string; path?: string } }).root;
        const path = root.kind === "suggested" ? `/Users/dana/${root.name}` : root.path!;
        return { ok: true, value: { path, created: true, repos: [] } };
      }
      default:
        return { ok: false, error: { kind: "unknown", code: "unmocked", message: name } };
    }
  });
  mocks.useForgeStatuses.mockReturnValue([]);
  (window as unknown as { pwrgit: { platform: string } }).pwrgit = { platform: "darwin" };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function toStep3(): Promise<void> {
  await click("Start");
  await click("Continue");
  await click("Continue");
}

describe("OnboardingWizard", () => {
  it("opens on Welcome, which is before the rail starts", async () => {
    await mount();
    expect(text()).toContain("Point PwrGit at your code");
    expect(container.querySelector(".onboarding-wizard__rail")).toBeNull();
  });

  it("opens at the step Finish setup names, when given one", async () => {
    await mount({ initialStep: "forges", isReplay: true });
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Forges");
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

  it("names the directories a conditional include re-points", async () => {
    identity = { ...identity, conditionalDirs: ["~/work/"] };
    await mount();
    await click("Start");
    expect(text()).toContain("sets a different identity for repositories under");
    expect(text()).toContain("~/work/");
  });

  // Card 3d: a blank field no longer blocks. The start screen names what is
  // missing instead, and a half-filled pair is not written to the profile.
  it("lets Continue through Identity with a blank field, and does not save it", async () => {
    identity = { name: null, email: null, conditionalDirs: [] };
    const onSetIdentity = vi.fn(async () => undefined);
    const { onDismiss } = await mount({ onSetIdentity });
    await click("Start");
    expect(button("Continue").disabled).toBe(false);
    await click("Continue");
    expect(text()).toContain("Step 2");
    await click("Skip setup");
    expect(onDismiss).toHaveBeenCalledWith(true);
    expect(onSetIdentity).not.toHaveBeenCalled();
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

  it("opens step 3 on the choice, with the search selected, and the rules behind a link", async () => {
    await mount();
    await toStep3();
    expect(text()).toContain("Where are your repositories?");
    expect(railLabels()[2]).toBe("Repositories");
    expect(button("Find my repositories").textContent).toContain("Find my repositories");
    expect(text()).not.toContain("five levels down");
    await click("What it opens and what it never does");
    // The facts that made the old rules page: depth, never inside a
    // repository, hidden folders, names not files.
    expect(text()).toContain("five levels down");
    expect(text()).toContain("never opened");
    expect(text()).toContain(".ssh");
    expect(text()).toContain("node_modules");
    expect(text()).toContain("reads folder names, not files");
    // Nothing searched until the button is pressed.
    expect(mocks.dispatch).not.toHaveBeenCalledWith("repo:searchHome", expect.anything());
  });

  it("names the primary button after the selected answer", async () => {
    await mount();
    await toStep3();
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    await act(async () => radios[1]!.click());
    expect(button("Choose folders…")).toBeTruthy();
    await act(async () => radios[2]!.click());
    expect(button("Pick a folder")).toBeTruthy();
  });

  it("searches on the button, checks what the search proposes, and adds what is checked", async () => {
    search = {
      ...EMPTY_SEARCH,
      folders: [
        folder("/Users/dana/code", ["api", "web"]),
        folder("/Users/dana/trees", [], {
          checked: false,
          worktreeCount: 2,
          note: { kind: "worktrees-of", repositoryFolders: ["/Users/dana/code"] }
        })
      ]
    };
    const onSetRoots = vi.fn(async () => undefined);
    await mount({ onSetRoots });
    await toStep3();
    await click("Find my repositories");
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "repo:searchHome",
      expect.objectContaining({ profileId: "personal", includeProtected: false })
    );
    expect(text()).toContain("Found 2 repositories in 1 folder.");
    expect(text()).toContain("of repositories in ~/code, which already brings them in");
    expect(text()).toContain("Also look in Documents, Desktop and Downloads");
    await click("Add 1 folder");
    expect(onSetRoots).toHaveBeenCalledWith("personal", ["/Users/dana/code"]);
    expect(railLabels()[2]).toBe("Repositories");
  });

  it("offers the protected folders, the picker and I do not have any when the search finds nothing", async () => {
    await mount();
    await toStep3();
    await click("Find my repositories");
    expect(text()).toContain("No repositories within three folders of home.");
    expect(text()).toContain("Documents, Desktop and Downloads were not searched.");
    await click("Look in Documents, Desktop and Downloads");
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "repo:searchHome",
      expect.objectContaining({ includeProtected: true })
    );
    await click("I do not have any yet");
    expect(text()).toContain("Pick a folder for your repositories.");
  });

  it("says Scanning until the scan reports, then the count", async () => {
    let finish: () => void = () => undefined;
    const onSetRoots = vi.fn(
      () => new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    const pickDirectories = vi.fn(async () => ["/Users/dana/code"]);
    await mount({ onSetRoots, pickDirectories });
    await toStep3();
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    await act(async () => radios[1]!.click());
    await click("Choose folders…");
    expect(pickDirectories).toHaveBeenCalled();
    await click("Scan 1 folder");
    expect(text()).toContain("Scanning 1 folder…");
    await act(async () => finish());
    expect(text()).toContain("Nothing found in that folder.");
    expect(text()).toContain("Find my repositories instead");
  });

  it("I do not have any: creates the suggested folder, then Done offers Clone", async () => {
    const onOpenClone = vi.fn();
    const { onDismiss } = await mount({ onOpenClone });
    await toStep3();
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    await act(async () => radios[2]!.click());
    await click("Pick a folder");
    expect(text()).toContain("~/projects does not exist yet. PwrGit will create it when you continue.");
    await click("Create ~/projects");
    expect(mocks.dispatch).toHaveBeenCalledWith("profile:createRoot", {
      profileId: "personal",
      root: { kind: "suggested", name: "projects" }
    });
    // Card 3c: next moves, not a key to empty chips.
    expect(text()).toContain("~/projects is ready. Put a repository in it.");
    expect(text()).not.toContain("What the five chips will mean");
    expect(button("Close")).toBeTruthy();
    await click("Clone a repository…");
    expect(onDismiss).toHaveBeenCalledWith(true);
    expect(onOpenClone).toHaveBeenCalled();
  });

  it("says Use for a suggested folder that already exists", async () => {
    await mount();
    await toStep3();
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    await act(async () => radios[2]!.click());
    await click("Pick a folder");
    const github = [...container.querySelectorAll<HTMLInputElement>('input[name="home-root"]')][1]!;
    await act(async () => github.click());
    expect(button("Use ~/github")).toBeTruthy();
    expect(text()).toContain("~/github already exists.");
  });

  it("warns when a home directory is added as a root", async () => {
    await mount({
      profile: { ...PROFILE, roots: ["/Users/dana"] },
      pickDirectories: vi.fn(async () => [])
    });
    await toStep3();
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    await act(async () => radios[1]!.click());
    await click("Choose folders…");
    expect(text()).toContain("Adding your home folder works, and we would not");
  });

  it("Done describes the lenses rather than counting what a scan cannot know", async () => {
    const repo = {
      id: "r1",
      path: "/code/ledger-api",
      worktrees: [{ id: "w1" }, { id: "w2" }]
    } as unknown as Repo;
    await mount({ profile: { ...PROFILE, roots: ["/code"] }, repos: [repo] });
    await toStep3();
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    await act(async () => radios[1]!.click());
    await click("Choose folders…");
    await click("Scan 1 folder");
    await click("See the result");
    expect(text()).toContain("1 repository, 2 worktrees, 1 folder.");
    // No Focused/Pinned/Behind counts — they are explained, not asserted.
    expect(text()).toContain("Empty until you start working");
    expect(text()).toContain("a scan does not pin anything for you");
  });
});
