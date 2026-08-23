// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeleteProfileRequest, Profile } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  useProfiles: vi.fn()
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
  roots: []
};
const acme: Profile = {
  id: "acme",
  name: "Acme",
  email: "me@acme.dev",
  mono: "A",
  roots: ["/projects/acme"]
};

let container: HTMLDivElement;
let root: Root;
const deleteProfile = vi.fn<
  (req: DeleteProfileRequest) => Promise<string | null>
>(async () => null);

function profileState(profiles: Profile[]) {
  return {
    profiles,
    activeProfileId: profiles[0]?.id ?? null,
    activeProfile: profiles[0] ?? null,
    openProfile: vi.fn(async () => undefined),
    createProfile: vi.fn(async () => null),
    updateProfile: vi.fn(async () => null),
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

beforeEach(() => {
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
    expect(remove.title).toBe("PwrGit must keep at least one profile");
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
});
