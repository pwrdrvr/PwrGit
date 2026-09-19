// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type Profile } from "@pwrgit/shared";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));

import { ProfileModal } from "./ProfileModal";

/**
 * The profile modal's way into the AI settings. They are per profile but
 * live in the shared Settings window, so the link has to say which profile
 * it means — otherwise Settings opens on whichever profile it guesses.
 */
const ACME: Profile = {
  id: "acme",
  name: "Acme",
  email: "dev@acme.example",
  mono: "A",
  roots: [],
  onboardingCompleted: true
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

async function render(mode: "create" | "edit"): Promise<void> {
  await act(async () => {
    root.render(
      <ProfileModal
        mode={mode}
        profile={mode === "edit" ? ACME : undefined}
        onCreate={async () => null}
        onUpdate={async () => null}
        onSetRoots={async () => {}}
        pickDirectories={async () => []}
        onClose={() => {}}
      />
    );
  });
}

function aiLink(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === "Open AI settings…"
  );
}

describe("ProfileModal — AI settings link", () => {
  it("opens Settings on AI Providers for this profile", async () => {
    await render("edit");
    await act(async () => aiLink()?.click());

    expect(mocks.dispatch).toHaveBeenCalledWith("settings:open", {
      page: "ai-providers",
      profileId: "acme"
    });
  });

  it("is not offered while the profile is still being created", async () => {
    // There is no id yet to point Settings at.
    await render("create");

    expect(aiLink()).toBeUndefined();
  });

  it("says so when Settings could not be opened", async () => {
    mocks.dispatch.mockResolvedValue(
      err({ kind: "validation", code: "invalid_settings_route", message: "That settings page does not exist." })
    );
    await render("edit");
    await act(async () => aiLink()?.click());

    expect(container.querySelector(".modal__error")?.textContent).toBe(
      "That settings page does not exist."
    );
  });
});
