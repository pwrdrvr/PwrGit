// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type RepositorySetup } from "@pwrgit/shared";
const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../lib/pwrgit", () => mocks);
import { RepositorySetupSheet } from "./RepositorySetupSheet";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const setup: RepositorySetup = {
  hooks: { directory: "/repo/.git/hooks", displayDirectory: ".git/hooks", configuredPath: null, origin: null, manager: null, active: [], shadowed: [], sampleCount: 0, lfsShadowed: false, worktreeCount: 1 },
  ignore: [
    { destination: "gitignore", path: "/repo/.gitignore", displayPath: ".gitignore", scope: "committed · team", lines: [], content: "" },
    { destination: "exclude", path: "/repo/.git/info/exclude", displayPath: ".git/info/exclude", scope: "this clone · 1 worktree", lines: [], content: "" },
    { destination: "global", path: "/home/you/.config/git/ignore", displayPath: "~/.config/git/ignore", scope: "this computer", lines: [], content: "" }
  ],
  ghDefault: null
};

const ambiguous: RepositorySetup = {
  ...setup,
  ghDefault: {
    status: "ambiguous",
    host: "github.com",
    repository: "tobi/disktree",
    remote: "upstream",
    candidates: [
      { host: "github.com", repository: "tobi/disktree", remotes: ["upstream"] },
      { host: "github.com", repository: "pwrdrvr/PwrDisk", remotes: ["origin", "pwrdrvr"] }
    ],
    fix: "gh repo set-default pwrdrvr/PwrDisk",
    warning: "No gh default repository is set."
  }
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockImplementation(async (name: string) => name === "repo:setup" ? ok(setup) : ok(null));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const layerTitles = () => [...container.querySelectorAll(".repository-setup__layer header strong")].map((node) => node.textContent);

describe("RepositorySetupSheet ignore layers", () => {
  it.each([
    ["darwin", "This Mac"],
    ["win32", "This PC"],
    ["linux", "This computer"]
  ])("titles the global excludes layer for %s as %s", async (platform, title) => {
    await act(async () => root.render(<RepositorySetupSheet repo={{ id: "r1", name: "repo", path: "/repo" }} initialPage="ignore" onClose={vi.fn()} platform={platform} />));
    expect(layerTitles()).toEqual(["Team rules", "This clone", title]);
  });
});

describe("RepositorySetupSheet GitHub CLI page", () => {
  it("names the repository gh would use and offers the set-default command", async () => {
    mocks.dispatch.mockImplementation(async (name: string) => name === "repo:setup" ? ok(ambiguous) : ok(null));
    await act(async () => root.render(<RepositorySetupSheet repo={{ id: "r1", name: "disktree", path: "/repo" }} initialPage="gh" onClose={vi.fn()} />));
    expect(container.querySelector(".repository-setup__warning strong")?.textContent).toBe("No default repository is set");
    expect(container.querySelector(".repository-setup__fix code")?.textContent).toBe("gh repo set-default pwrdrvr/PwrDisk");
    expect(container.querySelector(".repository-setup__candidate.is-chosen code")?.textContent).toBe("tobi/disktree");
    expect([...container.querySelectorAll(".repository-setup__candidate span")].map((node) => node.textContent)).toEqual(["upstream", "origin, pwrdrvr"]);
  });

  it("does not warn once a default is set", async () => {
    mocks.dispatch.mockImplementation(async (name: string) => name === "repo:setup"
      ? ok({ ...ambiguous, ghDefault: { ...ambiguous.ghDefault!, status: "set", repository: "pwrdrvr/PwrDisk", remote: "origin", fix: null, warning: null } })
      : ok(null));
    await act(async () => root.render(<RepositorySetupSheet repo={{ id: "r1", name: "disktree", path: "/repo" }} initialPage="gh" onClose={vi.fn()} />));
    expect(container.querySelector(".repository-setup__warning")).toBeNull();
    expect(container.querySelector(".repository-setup__resolved")?.textContent).toContain("pwrdrvr/PwrDisk");
  });
});
