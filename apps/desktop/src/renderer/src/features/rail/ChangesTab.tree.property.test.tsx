// @vitest-environment jsdom

import fc from "fast-check";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ok, type ChangeSet, type Worktree } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn() }));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe,
  windowProfileId: () => null
}));
vi.mock("../shell/dialogs", () => ({ confirmDialog: vi.fn(), notifyDialog: vi.fn() }));
vi.mock("../../lib/toast", () => ({ showErrorToast: vi.fn(), showInfoToast: vi.fn() }));
vi.mock("../../lib/copyText", () => ({ copyText: vi.fn() }));
vi.mock("./SubmodulePanel", () => ({ SubmodulePanel: () => null }));

import { ChangesTab } from "./ChangesTab";

/**
 * The rule the flat per-parent grouping broke: folding a folder row hides
 * every changed file beneath it — nested folders included — and the row's
 * count and Stage cover that same set. Read entirely from the rendered rail
 * (button labels carry full paths), so it holds any row model to account.
 */
const under = (path: string, dir: string): boolean => path.startsWith(`${dir}/`);

const segment = fc.constantFrom("a", "b", "src", "lib");
// At most 10 files, so no folder starts folded by the untracked-dump default.
const pathsArb = fc
  .uniqueArray(
    fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => `${parts.join("/")}.ts`),
    { minLength: 1, maxLength: 10 }
  );

async function renderRail(unstaged: string[]) {
  const listed: ChangeSet = {
    staged: [],
    unstaged: unstaged.map((path) => ({ path, status: "M", staged: false }))
  };
  mocks.subscribe.mockReturnValue(() => undefined);
  mocks.dispatch.mockImplementation(async (command: string) =>
    command === "changes:list" ? ok(listed) : ok(null)
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ChangesTab
        worktree={{ id: "worktree-1" } as Worktree}
        activeEmail="a@b.c"
        onOpenDiff={vi.fn()}
        onOpenFileInsight={vi.fn()}
        activeFile={null}
      />
    );
  });
  const labelled = (prefix: string): string[] =>
    [...container.querySelectorAll("button")]
      .map((b) => b.getAttribute("aria-label") ?? "")
      .filter((label) => label.startsWith(prefix))
      .map((label) => label.slice(prefix.length));
  return {
    container,
    visibleFiles: () => labelled("Stage ").filter((l) => !l.startsWith("all ")),
    folderDirs: () => labelled("Hide the files in "),
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    }
  };
}

describe("ChangesTab tree (property)", () => {
  it("folding a folder hides every file beneath it and nothing else", async () => {
    await fc.assert(
      fc.asyncProperty(pathsArb, fc.nat(), async (paths, pick) => {
        const rail = await renderRail(paths);
        try {
          const dirs = rail.folderDirs();
          fc.pre(dirs.length > 0);
          const dir = dirs[pick % dirs.length] ?? "";
          const beneath = paths.filter((p) => under(p, dir));

          const row = [...rail.container.querySelectorAll(".folder-row")].find(
            (r) => r.querySelector(`[aria-label="Hide the files in ${dir}"]`) !== null
          );
          expect(row?.querySelector(".folder-row__count")?.textContent).toBe(
            String(beneath.length)
          );

          const twisty = row?.querySelector<HTMLButtonElement>(".folder-row__twisty");
          await act(async () => twisty?.click());

          expect([...rail.visibleFiles()].sort()).toEqual(
            paths.filter((p) => !under(p, dir)).sort()
          );
          expect(rail.folderDirs().every((d) => !under(d, dir))).toBe(true);
        } finally {
          await rail.cleanup();
        }
      }),
      { numRuns: 60 }
    );
  });
});
