// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type FolderIdentityReport, type Profile } from "@pwrgit/shared";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn(() => () => undefined) }));
vi.mock("../../lib/pwrgit", () => mocks);
import { ProfileChip } from "./ProfileChip";

const WORK: Profile = {
  id: "work",
  name: "Work",
  email: "rowan@northwind.example",
  mono: "W",
  roots: ["/home/rowan/Work"],
  onboardingCompleted: true,
  showInMenu: true
};

const REPORT: FolderIdentityReport = {
  enabled: false,
  globalFile: "/home/rowan/.gitconfig",
  machine: {
    kind: "configured",
    author: { name: "Rowan Vale", email: "rowan@vale.example" },
    committer: { name: "Rowan Vale", email: "rowan@vale.example" }
  },
  profiles: [
    {
      profileId: "work",
      name: "Work",
      mono: "W",
      email: WORK.email,
      authorName: null,
      roots: WORK.roots,
      overlaps: [],
      includeFile: "/home/rowan/.gitconfig-pwrgit-work",
      repos: [
        {
          repoId: "r-api",
          name: "api",
          path: "/home/rowan/Work/api",
          email: "rowan@vale.example",
          authorName: null,
          source: "global",
          origin: "/home/rowan/.gitconfig",
          matches: false
        }
      ]
    }
  ]
};

let root: Root;
let container: HTMLDivElement;
const onOpenGitIdentity = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockImplementation(async (name: string) =>
    name === "identity:folders" ? ok(REPORT) : ok(null)
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function openMenu(): Promise<void> {
  await act(async () => {
    root.render(
      <ProfileChip
        profiles={[WORK]}
        activeProfile={WORK}
        onSwitch={() => undefined}
        onNewProfile={() => undefined}
        onManageProfile={() => undefined}
        onOpenGitIdentity={onOpenGitIdentity}
      />
    );
  });
  expect(mocks.dispatch).not.toHaveBeenCalledWith("identity:folders", expect.anything());
  await act(async () => container.querySelector<HTMLButtonElement>(".profile-chip")!.click());
}

describe("profile popup › Git outside PwrGit", () => {
  it("asks about this profile's repos only once the menu opens, and says what they commit as", async () => {
    await openMenu();
    expect(mocks.dispatch).toHaveBeenCalledWith("identity:folders", { profileId: "work" });
    const row = container.querySelector(".profile-menu__git");
    expect(row?.className).toContain("profile-menu__git--warn");
    expect(row?.textContent).toContain("Git outside PwrGit");
    expect(row?.textContent).toContain("Commits as rowan@vale.example in its 1 repo");
  });

  it("opens Settings › Profiles › By folder and closes the menu", async () => {
    await openMenu();
    await act(async () => container.querySelector<HTMLButtonElement>(".profile-menu__git")!.click());
    expect(onOpenGitIdentity).toHaveBeenCalledOnce();
    expect(container.querySelector(".profile-menu")).toBeNull();
  });
});
