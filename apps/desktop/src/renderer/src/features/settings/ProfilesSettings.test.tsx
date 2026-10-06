// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ok,
  type DeleteProfileRequest,
  type HiddenRepo,
  type Profile,
  type UpdateProfileRequest
} from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  useProfiles: vi.fn(),
  dispatch: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: () => () => undefined
}));

vi.mock("../../state/useProfiles", () => ({
  useProfiles: mocks.useProfiles
}));

import { ProfilesSettings } from "./ProfilesSettings";

const personal: Profile = {
  id: "personal",
  name: "Personal",
  email: "me@example.com",
  mono: "P",
  roots: [],
  onboardingCompleted: true,
  showInMenu: true
};
const acme: Profile = {
  id: "acme",
  name: "Acme",
  email: "me@acme.dev",
  mono: "A",
  roots: ["/projects/acme"],
  onboardingCompleted: true,
  showInMenu: true
};

let container: HTMLDivElement;
let root: Root;
const deleteProfile = vi.fn<
  (req: DeleteProfileRequest) => Promise<string | null>
>(async () => null);
const updateProfile = vi.fn<
  (req: UpdateProfileRequest) => Promise<string | null>
>(async () => null);
const reorderProfiles = vi.fn<
  (profileIds: string[]) => Promise<string | null>
>(async () => null);

function profileState(profiles: Profile[]) {
  return {
    profiles,
    activeProfileId: profiles[0]?.id ?? null,
    activeProfile: profiles[0] ?? null,
    loadState: { status: "ready" as const },
    retry: vi.fn(async () => undefined),
    openProfile: vi.fn(async () => undefined),
    createProfile: vi.fn(async () => null),
    updateProfile,
    reorderProfiles,
    deleteProfile,
    setRoots: vi.fn(async () => undefined),
    pickDirectories: vi.fn(async () => [])
  };
}

async function render(profiles: Profile[]): Promise<void> {
  mocks.useProfiles.mockReturnValue(profileState(profiles));
  await act(async () => {
    root.render(<ProfilesSettings />);
  });
}

function row(name: string): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>(".settings-profile-row")].find(
    (candidate) => candidate.textContent?.includes(name) === true
  )!;
}

function button(parent: ParentNode, name: string): HTMLButtonElement {
  return [...parent.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name
  )!;
}

async function typeConfirmation(value: string): Promise<void> {
  const field = container.querySelector<HTMLInputElement>(
    ".modal--delete-profile .modal__input"
  )!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

let hidden: HiddenRepo[] = [];

beforeEach(() => {
  // Shortcut caps read the platform from the preload bridge.
  (window as unknown as { pwrgit: { platform: string } }).pwrgit = {
    platform: "darwin"
  };
  hidden = [];
  mocks.dispatch.mockImplementation((channel: string) =>
    Promise.resolve(ok(channel === "repo:hiddenList" ? hidden : null))
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("ProfilesSettings deletion", () => {
  it("protects the final profile in the component", async () => {
    await render([personal]);

    const remove = button(row("Personal"), "Delete…");
    expect(remove.disabled).toBe(true);
    // In the NAME: a disabled button announces its name, and AT reads that
    // over any hover card.
    expect(remove.getAttribute("aria-label")).toBe(
      "Delete… Personal — unavailable, PwrGit must keep at least one profile"
    );
  });

  it("names removed and retained data, then requires an exact profile name", async () => {
    await render([personal, acme]);
    await act(async () => button(row("Acme"), "Delete…").click());

    const dialog = container.querySelector<HTMLElement>(
      ".modal--delete-profile"
    )!;
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.textContent).toContain("Delete “Acme”?");
    expect(dialog.textContent).toContain(
      "indexed records for repositories, worktrees and branches"
    );
    expect(dialog.textContent).toContain(
      "Not deleted: repository folders, Git repositories, worktrees, branches, commits, or files on disk."
    );

    const remove = button(dialog, "Delete profile");
    expect(remove.disabled).toBe(true);
    await typeConfirmation("acme");
    expect(remove.disabled).toBe(true);
    await typeConfirmation("Acme");
    expect(remove.disabled).toBe(false);

    await act(async () => {
      remove.click();
      await Promise.resolve();
    });
    expect(deleteProfile).toHaveBeenCalledExactlyOnceWith({
      profileId: acme.id,
      expectedName: acme.name
    });
  });

  it("keeps the confirmation open when main rejects deletion", async () => {
    deleteProfile.mockResolvedValueOnce("PwrGit must keep at least one profile");
    await render([personal, acme]);
    await act(async () => button(row("Acme"), "Delete…").click());
    await typeConfirmation("Acme");

    await act(async () => {
      button(container, "Delete profile").click();
      await Promise.resolve();
    });

    expect(container.querySelector(".modal--delete-profile")).not.toBeNull();
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "at least one profile"
    );
  });

  it("cannot dismiss the confirmation backdrop while deletion is pending", async () => {
    let finishDelete = (_message: string | null): void => undefined;
    deleteProfile.mockReturnValueOnce(
      new Promise<string | null>((resolve) => {
        finishDelete = resolve;
      })
    );
    await render([personal, acme]);
    await act(async () => button(row("Acme"), "Delete…").click());
    await typeConfirmation("Acme");

    await act(async () => {
      button(container, "Delete profile").click();
      await Promise.resolve();
    });
    const backdrop = container.querySelector<HTMLElement>(".overlay-backdrop")!;
    await act(async () => backdrop.click());

    expect(container.querySelector(".modal--delete-profile")).not.toBeNull();
    expect(button(container, "Deleting…").disabled).toBe(true);

    await act(async () => {
      finishDelete(null);
      await Promise.resolve();
    });
    expect(container.querySelector(".modal--delete-profile")).toBeNull();
  });
});

describe("ProfilesSettings menu order and visibility", () => {
  const scratch: Profile = {
    id: "scratch",
    name: "Scratch",
    email: "",
    mono: "S",
    roots: [],
    onboardingCompleted: true,
    showInMenu: false
  };

  function grip(name: string): HTMLButtonElement {
    return row(name).querySelector<HTMLButtonElement>(
      ".settings-profile-row__grip"
    )!;
  }

  it("shows each profile's menu shortcut, numbered over the profiles the menu shows", async () => {
    await render([personal, scratch, acme]);

    const shortcut = (name: string) =>
      row(name).querySelector(".settings-profile-row__shortcut")?.textContent ?? null;
    expect(shortcut("Personal")).toBe("⌘1");
    expect(shortcut("Scratch")).toBeNull();
    expect(
      row("Scratch").querySelector('[role="switch"]')?.getAttribute("aria-checked")
    ).toBe("false");
    // Scratch is skipped, so Acme takes the next number rather than ⌘3.
    expect(shortcut("Acme")).toBe("⌘2");
  });

  it("switches a profile out of the Profiles menu", async () => {
    await render([personal, acme]);

    const toggle = row("Acme").querySelector<HTMLButtonElement>(
      '[role="switch"]'
    )!;
    expect(toggle.getAttribute("aria-label")).toBe(
      "Show Acme in the Profiles menu"
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());

    expect(updateProfile).toHaveBeenCalledExactlyOnceWith({
      profileId: "acme",
      showInMenu: false
    });
  });

  it("moves a profile with the arrow keys on its grip", async () => {
    await render([personal, scratch, acme]);

    await act(async () => {
      grip("Acme").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })
      );
    });
    expect(reorderProfiles).toHaveBeenCalledExactlyOnceWith([
      "personal",
      "acme",
      "scratch"
    ]);

    // Already first: nothing to move past.
    reorderProfiles.mockClear();
    await act(async () => {
      grip("Personal").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })
      );
    });
    expect(reorderProfiles).not.toHaveBeenCalled();
  });

  it("builds a second quick move on the first, before main confirms it", async () => {
    // Main's profile:changed never arrives here (the mock list is fixed), so
    // the second move has to start from the order the first one asked for.
    await render([personal, scratch, acme]);
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        grip("Acme").dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })
        );
      });
    }
    expect(reorderProfiles.mock.calls).toEqual([
      [["personal", "acme", "scratch"]],
      [["acme", "personal", "scratch"]]
    ]);
    expect(
      [...container.querySelectorAll<HTMLElement>(".settings-profile-row")].map(
        (element) => element.dataset["profileId"]
      )
    ).toEqual(["acme", "personal", "scratch"]);
  });

  it("keeps focus on the grip when a profile moves down", async () => {
    await render([personal, scratch, acme]);
    await act(async () => {
      grip("Personal").focus();
      grip("Personal").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
    });
    expect(reorderProfiles).toHaveBeenCalledExactlyOnceWith([
      "scratch",
      "personal",
      "acme"
    ]);
    expect(document.activeElement).toBe(grip("Personal"));
  });

  it("reorders by drag and drop", async () => {
    await render([personal, scratch, acme]);
    const store = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      get types() {
        return [...store.keys()];
      },
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? ""
    };
    const fire = (target: HTMLElement, type: string, clientY = 0) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { dataTransfer, clientY });
      target.dispatchEvent(event);
    };

    // jsdom lays nothing out, so every row's box is empty and any pointer
    // lands in its lower half: the drop goes after the target.
    await act(async () => fire(row("Personal"), "dragstart"));
    await act(async () => fire(row("Acme"), "dragover"));
    await act(async () => fire(row("Acme"), "drop"));

    expect(reorderProfiles).toHaveBeenCalledExactlyOnceWith([
      "scratch",
      "acme",
      "personal"
    ]);
  });

  it("says so when the order could not be saved", async () => {
    reorderProfiles.mockResolvedValueOnce(
      "The profile list changed while you were reordering it. Try again."
    );
    await render([personal, acme]);

    await act(async () => {
      grip("Acme").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The profile list changed while you were reordering it. Try again."
    );
  });
});

describe("ProfilesSettings hidden repositories", () => {
  const entry = (over: Partial<HiddenRepo>): HiddenRepo => ({
    profileId: "personal",
    profileName: "Personal",
    path: "/src/harbor-api",
    name: "harbor-api",
    hiddenAt: "2026-10-01T00:00:00.000Z",
    repoId: "r1",
    worktreeCount: 3,
    missing: false,
    ...over
  });

  const card = (): HTMLElement =>
    [...container.querySelectorAll<HTMLElement>("section, div")].find((el) =>
      el.querySelector(".settings-hidden-repos, .settings-empty") !== null &&
      el.textContent?.includes("Hidden repositories") === true
    )!;

  it("says so when nothing is hidden", async () => {
    await render([personal]);
    expect(container.textContent).toContain("Hidden repositories");
    expect(container.textContent).toContain("No hidden repositories.");
    expect(container.textContent).toContain("0 hidden");
  });

  it("groups every profile's entries, and forgets one that is gone", async () => {
    hidden = [
      entry({ profileId: "acme", profileName: "Acme", path: "/projects/acme/legacy", name: "legacy", repoId: null, worktreeCount: 0, missing: true }),
      entry({})
    ];
    await render([personal, acme]);
    const groups = [...container.querySelectorAll<HTMLElement>(".settings-hidden-repos__group")];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Hidden in Acme",
      "Hidden in Personal"
    ]);
    // The window's active profile carries the chip.
    expect(groups[1]?.textContent).toContain("Active");
    expect(groups[0]?.textContent).toContain("Not found on disk. It was moved or deleted outside PwrGit.");
    expect(groups[1]?.textContent).toContain("/src/harbor-api · 2 worktrees");
    expect(card().textContent).toContain("2 hidden");

    await act(async () => button(groups[0]!, "Forget").click());
    expect(mocks.dispatch).toHaveBeenCalledWith("repo:unhide", {
      profileId: "acme",
      path: "/projects/acme/legacy"
    });
    await act(async () => button(groups[1]!, "Unhide").click());
    expect(mocks.dispatch).toHaveBeenCalledWith("repo:unhide", {
      profileId: "personal",
      path: "/src/harbor-api"
    });
  });
});
