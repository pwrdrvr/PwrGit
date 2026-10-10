// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type FolderIdentityReport, type FolderSyncPlan } from "@pwrgit/shared";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn(() => () => undefined) }));
vi.mock("../../lib/pwrgit", () => mocks);
import { FolderIdentitySection } from "./FolderIdentitySettings";

const WORK = "rowan@northwind.example";
const PERSONAL = "rowan@vale.example";

function report(enabled: boolean, infraLocal = false): FolderIdentityReport {
  return {
    enabled,
    globalFile: "/home/rowan/.gitconfig",
    machine: {
      kind: "configured",
      author: { name: "Rowan Vale", email: PERSONAL },
      committer: { name: "Rowan Vale", email: PERSONAL }
    },
    profiles: [
      {
        profileId: "work",
        name: "Work",
        mono: "W",
        email: WORK,
        authorName: null,
        roots: ["/home/rowan/Work"],
        overlaps: [],
        includeFile: "/home/rowan/.gitconfig-pwrgit-work",
        repos: [
          {
            repoId: "r-api",
            name: "api",
            path: "/home/rowan/Work/api",
            email: enabled ? WORK : PERSONAL,
            authorName: null,
            source: enabled ? "pwrgit" : "global",
            origin: enabled ? "/home/rowan/.gitconfig-pwrgit-work" : "/home/rowan/.gitconfig",
            matches: enabled
          },
          {
            repoId: "r-infra",
            name: "infra-live",
            path: "/home/rowan/Work/infra-live",
            email: infraLocal ? PERSONAL : WORK,
            authorName: null,
            source: infraLocal ? "local" : "pwrgit",
            origin: infraLocal ? "/home/rowan/Work/infra-live/.git/config" : "/home/rowan/.gitconfig-pwrgit-work",
            matches: !infraLocal
          }
        ]
      }
    ]
  };
}

const PLAN: FolderSyncPlan = {
  enabled: true,
  globalFile: "/home/rowan/.gitconfig",
  remove: [],
  add: [{ condition: "gitdir:/home/rowan/Work/", path: "/home/rowan/.gitconfig-pwrgit-work" }],
  files: [
    {
      path: "/home/rowan/.gitconfig-pwrgit-work",
      content: `# Written by PwrGit\n[user]\n\temail = "${WORK}"\n`,
      exists: false
    }
  ],
  deleteFiles: [],
  skipped: []
};

let root: Root;
let container: HTMLDivElement;
const accept = vi.fn();

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((entry) => entry.textContent === text);
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

async function render(current: FolderIdentityReport): Promise<void> {
  await act(async () => {
    root.render(
      <FolderIdentitySection
        folders={{ report: current, refresh: () => undefined, accept }}
        onEditProfile={() => undefined}
      />
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockImplementation(async (name: string) => {
    if (name === "identity:folderPlan") return ok(PLAN);
    if (name === "identity:setFolderSync") return ok(report(true));
    if (name === "identity:clearRepoOverride") return ok(report(true));
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

describe("Settings › Profiles › By folder", () => {
  it("reports what Git does today while off, and writes only after the preview", async () => {
    await render(report(false));
    expect(container.textContent).toContain("1 repo differs");
    expect(container.textContent).toContain(`1 of 2 repos match`);
    // The tag counts the same repos the card's chip does.
    expect(container.querySelector(".folder-identity__side")?.textContent).toBe("1 differ");

    await act(async () => container.querySelector<HTMLButtonElement>("[role='switch']")!.click());
    expect(mocks.dispatch).toHaveBeenCalledWith("identity:folderPlan", { enabled: true });
    const dialog = document.querySelector("[role='dialog']");
    expect(dialog?.textContent).toContain('+ [includeIf "gitdir:/home/rowan/Work/"]');
    expect(dialog?.textContent).toContain("/home/rowan/.gitconfig-pwrgit-work — new");
    expect(mocks.dispatch).not.toHaveBeenCalledWith("identity:setFolderSync", expect.anything());

    await act(async () => button("Write to Git config").click());
    expect(mocks.dispatch).toHaveBeenCalledWith("identity:setFolderSync", { enabled: true });
    expect(accept).toHaveBeenCalledWith(report(true));
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("lists a repo that pins its own email and removes the override after asking", async () => {
    await render(report(true, true));
    expect(container.textContent).toContain("infra-live");
    expect(container.textContent).toContain("set in this repo’s .git/config");

    await act(async () => button("Remove override…").click());
    expect(document.querySelector("[role='dialog']")?.textContent).toContain(
      "git config --local --unset-all user.email"
    );
    await act(async () => button("Remove override").click());
    expect(mocks.dispatch).toHaveBeenCalledWith("identity:clearRepoOverride", { repoId: "r-infra" });
    expect(accept).toHaveBeenCalled();
  });

  it("says In step when every repo matches", async () => {
    await render(report(true));
    expect(container.textContent).toContain("In step");
    expect(container.textContent).toContain(`All 2 repos commit as ${WORK}`);
  });
});
