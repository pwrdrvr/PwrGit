// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type Profile } from "@pwrgit/shared";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));

import { ProfileModal } from "./ProfileModal";

const ACME: Profile = {
  id: "acme",
  name: "Acme",
  email: "dev@acme.example",
  mono: "A",
  roots: [],
  onboardingCompleted: true,
  showInMenu: true
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockResolvedValue(ok(null));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ProfileModal — folders and Git identity", () => {
  const WORK: Profile = { ...ACME, id: "work", name: "Work", roots: ["/home/rowan/Work"] };

  async function renderWith(options: {
    picked?: string[];
    folderSync?: boolean;
    onSetRoots?: (profileId: string, roots: string[]) => Promise<string | null>;
  }): Promise<void> {
    mocks.dispatch.mockImplementation(async (name: string) =>
      name === "settings:read"
        ? ok({ general: { gitIdentityByFolder: options.folderSync ?? false } })
        : ok(null)
    );
    await act(async () => {
      root.render(
        <ProfileModal
          mode="edit"
          profile={ACME}
          profiles={[ACME, WORK]}
          onCreate={async () => null}
          onUpdate={async () => null}
          onSetRoots={options.onSetRoots ?? (async () => null)}
          pickDirectories={async () => options.picked ?? []}
          onClose={() => {}}
        />
      );
    });
  }

  function save(): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>(".modal__create")!;
  }

  it("refuses a folder inside another profile's as it is added", async () => {
    await renderWith({ picked: ["/home/rowan/Work/oss"] });
    const add = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add folders"));
    await act(async () => add!.click());
    expect(container.querySelector(".rootlist__item.is-overlap")?.textContent).toContain("/home/rowan/Work/oss");
    expect(container.querySelector(".rootlist__error")?.textContent).toContain(
      "/home/rowan/Work/oss is inside /home/rowan/Work, a folder of “Work”."
    );
    expect(save().disabled).toBe(true);
  });

  it("shows main's refusal of the folders instead of closing", async () => {
    const onSetRoots = vi.fn(async () => "Nope: that folder belongs to Work.");
    await renderWith({ picked: ["/home/rowan/Other"], onSetRoots });
    const add = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add folders"));
    await act(async () => add!.click());
    await act(async () => save().click());
    expect(onSetRoots).toHaveBeenCalledWith("acme", ["/home/rowan/Other"]);
    expect(container.querySelector(".modal__error")?.textContent).toBe("Nope: that folder belongs to Work.");
  });

  it("says Git outside PwrGit follows the profile while folder sync is on", async () => {
    await renderWith({ folderSync: false });
    expect(container.querySelector(".profile-modal__git-note")).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await renderWith({ folderSync: true });
    expect(container.querySelector(".profile-modal__git-note")?.textContent).toContain(
      "Git outside PwrGit follows this profile."
    );
  });
});
