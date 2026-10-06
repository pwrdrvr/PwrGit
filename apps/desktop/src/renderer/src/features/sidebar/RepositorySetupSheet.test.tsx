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
  ]
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
