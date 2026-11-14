// @vitest-environment jsdom

import fc from "fast-check";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: () => () => undefined,
  windowProfileId: () => null
}));

import { CommitTab } from "../rail/CommitTab";
import { ChangeRequestRail } from "../change-request/ChangeRequestRail";
import type { ChangeRequestViewState } from "../change-request/useChangeRequestView";
import { buildFileTree, fileLabel, visibleTreeRows } from "./file-tree";

/**
 * Every rail file list draws the same folder tree, not a flat list of full
 * paths: the rows on screen are the model's rows (label, depth, folders
 * first), each file row reads as its full path, and folding a folder hides
 * exactly the files beneath it. Before this, the Commit tab and the
 * change-request rail listed full paths flat.
 */
const under = (path: string, dir: string): boolean => path.startsWith(`${dir}/`);

const segment = fc.constantFrom("a", "b", "src", "lib");
const pathsArb = fc.uniqueArray(
  fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => `${parts.join("/")}.ts`),
  { minLength: 1, maxLength: 12 }
);

type Surface = {
  name: string;
  fileLabelSelector: string;
  fileRowSelector: string;
  /** `added` names the paths that are new in this list. */
  render: (paths: string[], added?: ReadonlySet<string>) => ReactElement;
};

const surfaces: Surface[] = [
  {
    name: "Commit tab",
    fileLabelSelector: ".file-row .file-path",
    fileRowSelector: ".file-row",
    render: (paths, added = new Set()) => {
      mocks.dispatch.mockImplementation(async (command: string) =>
        command === "commit:files"
          ? ok(paths.map((path) => ({ path, status: added.has(path) ? "A" : "M" })))
          : ok(null)
      );
      return (
        <CommitTab
          worktreeId="wt-1"
          hash="abc1234def"
          subject="a commit"
          view={null}
          onOpenFile={vi.fn()}
          onOpenFullDiff={vi.fn()}
          onClose={vi.fn()}
        />
      );
    }
  },
  {
    name: "change-request rail",
    fileLabelSelector: ".cr-rail__file .cr-rail__path",
    fileRowSelector: ".cr-rail__file",
    render: (paths, added = new Set()) => {
      const state = {
        view: null,
        fetching: null,
        error: null,
        scope: { kind: "all" },
        setScope: vi.fn(),
        patch: "diff",
        scopeError: null,
        files: paths.map((path) => ({
          path,
          status: added.has(path) ? "added" : "modified",
          hunks: [],
          additions: 1,
          deletions: 0,
          binary: false
        })),
        totals: null,
        showEnd: vi.fn(),
        fetchNow: vi.fn()
      } as unknown as ChangeRequestViewState;
      return <ChangeRequestRail state={state} now={0} onFocusFile={vi.fn()} onCollapse={vi.fn()} />;
    }
  }
];

async function mount(surface: Surface, paths: string[], added?: ReadonlySet<string>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(surface.render(paths, added)));
  const rows = (): string[] =>
    [...container.querySelectorAll(`.folder-row, ${surface.fileRowSelector}`)].map((row) => {
      const depth = (row as HTMLElement).style.getPropertyValue("--tree-depth") || "0";
      const folder = row.classList.contains("folder-row");
      const label = row.querySelector(folder ? ".folder-row__path" : surface.fileLabelSelector)?.textContent;
      return `${depth}:${folder ? "d" : "f"}:${label ?? ""}`;
    });
  return {
    container,
    rows,
    fileLabels: () =>
      [...container.querySelectorAll(surface.fileLabelSelector)].map((el) => el.textContent ?? ""),
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    }
  };
}

describe.each(surfaces)("$name draws a folder tree (property)", (surface) => {
  it("shows the model's rows, and a folded folder hides exactly its subtree", async () => {
    await fc.assert(
      fc.asyncProperty(pathsArb, fc.nat(), async (paths, pick) => {
        const list = await mount(surface, paths);
        try {
          const tree = buildFileTree(paths.map((path) => ({ path })));
          // A flat list keeps flat rows (no depth); a nested one is the tree.
          const nested = tree.folders.length > 0;
          expect(list.rows()).toEqual(
            visibleTreeRows(tree, () => true).map((row) =>
              row.kind === "folder"
                ? `${row.depth}:d:${row.folder.label}`
                : `${nested ? row.depth : 0}:f:${fileLabel(row.file.path)}`
            )
          );

          // A row shows only the file's name, but reads as its full path (the
          // folder part for screen readers), so `src/a.ts` and `lib/a.ts`
          // stay two different rows to anyone who can't see the indent.
          const read = [...list.container.querySelectorAll(surface.fileRowSelector)].map((el) => {
            const text = el.textContent ?? "";
            return paths.filter((p) => text.includes(p)).sort((a, b) => b.length - a.length)[0];
          });
          expect(read.sort()).toEqual([...paths].sort());

          const folders = [...list.container.querySelectorAll(".folder-row")];
          fc.pre(folders.length > 0);
          const row = folders[pick % folders.length];
          const twisty = row?.querySelector<HTMLButtonElement>(".folder-row__twisty");
          const dir = (twisty?.getAttribute("aria-label") ?? "").replace("Hide the files in ", "");
          expect(row?.querySelector(".folder-row__count")?.textContent).toBe(
            String(paths.filter((p) => under(p, dir)).length)
          );
          await act(async () => twisty?.click());
          expect([...list.fileLabels()].sort()).toEqual(
            paths.filter((p) => !under(p, dir)).map(fileLabel).sort()
          );
        } finally {
          await list.cleanup();
        }
      }),
      { numRuns: 40 }
    );
  });

  it("starts a folder of more than 10 added files folded, and no other", async () => {
    // A commit or PR that vendors a library lists hundreds of new files; the
    // folder holding them starts as one row, as an untracked dump does in
    // Changes. One edited file inside keeps it open.
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 16 }), fc.boolean(), async (count, edited) => {
        const fresh = Array.from({ length: count }, (_, i) => `vendor/lib/f${i}.ts`);
        const paths = [...fresh, ...(edited ? ["vendor/lib/edited.ts"] : []), "README.md"];
        const list = await mount(surface, paths, new Set(fresh));
        try {
          // The one folder row (`vendor/lib`, compacted) holds every file but README.
          const twisty = list.container.querySelector<HTMLButtonElement>(".folder-row__twisty");
          const folds = count > 10 && !edited;
          expect(twisty?.getAttribute("aria-expanded")).toBe(String(!folds));
          expect(list.fileLabels().length).toBe(folds ? 1 : paths.length);
        } finally {
          await list.cleanup();
        }
      }),
      // The rule flips between 10 and 11 files: always try both sides.
      { numRuns: 30, examples: [[10, false], [11, false], [11, true]] }
    );
  });
});
