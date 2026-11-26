// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import {
  ok,
  type ChangeSet,
  type IgnoredSummary,
  type Result
} from "@pwrgit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (payload: unknown) => void;
const channels = new Map<string, Set<Listener>>();

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn(),
  windowProfileId: vi.fn(() => "personal")
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe,
  windowProfileId: () => null
}));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));
vi.mock("../shell/dialogs", () => ({
  confirmDialog: vi.fn(),
  notifyDialog: vi.fn()
}));
vi.mock("./SubmodulePanel", () => ({ SubmodulePanel: () => null }));
vi.mock("../identity/useCommitIdentity", () => ({
  useCommitIdentity: () => ({ inspection: null, refresh: vi.fn() })
}));

import { ChangesTab } from "./ChangesTab";

function emit(channel: string, payload: unknown): void {
  for (const listener of [...(channels.get(channel) ?? [])]) {
    listener(payload);
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  channels.clear();
  mocks.subscribe.mockImplementation((channel: string, listener: Listener) => {
    let set = channels.get(channel);
    if (set === undefined) {
      set = new Set();
      channels.set(channel, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const emptyChanges = (): ChangeSet => ({
  staged: [],
  unstaged: []
});

const dirtyChanges = (paths: string[]): ChangeSet => ({
  staged: [],
  unstaged: paths.map((path) => ({ path, status: "M" as const, staged: false }))
});

const emptyIgnored = (): IgnoredSummary => ({ count: 0, rules: [], worktreeCount: 1 });

describe("ChangesTab async ordering and equivalence properties", () => {
  it("never lets an older changes:list reply overwrite a newer clean or updated reply", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("a.ts", "b.ts", "c.ts"), { minLength: 1, maxLength: 3 }),
        fc.integer({ min: 2, max: 5 }),
        async (staleFiles, overlappingCount) => {
          const listResolvers: Array<(res: Result<ChangeSet>) => void> = [];
          const ignoredResolvers: Array<(res: Result<IgnoredSummary>) => void> = [];

          mocks.dispatch.mockImplementation((name: string) => {
            if (name === "changes:list") {
              return new Promise<Result<ChangeSet>>((resolve) => {
                listResolvers.push(resolve);
              });
            }
            if (name === "changes:ignoredSummary") {
              return new Promise<Result<IgnoredSummary>>((resolve) => {
                ignoredResolvers.push(resolve);
              });
            }
            return Promise.resolve(ok(null));
          });

          const uniqueStale = [...new Set(staleFiles)];
          try {
            await act(async () => {
              root.render(
                <ChangesTab
                  worktree={{
                    id: "wt-1",
                    repoId: "repo-1",
                    path: "/sandbox/repo-1",
                    branch: "main",
                    dirty: 0,
                    ahead: 0,
                    behind: 0,
                    behindDefault: 0,
                    defaultBranch: "main",
                    mergedIntoDefault: false,
                    divergedFromDefault: false,
                    isDefaultBranch: true,
                    isPrimary: true,
                    pinned: false
                  }}
                  activeEmail="test@example.test"
                  activeFile={null}
                  onOpenDiff={() => undefined}
                  onOpenFileInsight={() => undefined}
                />
              );
            });

            // Trigger overlapping refreshes (e.g. worktree:changed + changes:changed).
            await act(async () => {
              for (let i = 1; i < overlappingCount; i++) {
                emit(i % 2 === 0 ? "changes:changed" : "worktree:changed", {
                  worktreeId: "wt-1"
                });
              }
            });
            expect(listResolvers).toHaveLength(overlappingCount);

            // Newest reply lands clean first.
            const newestList = listResolvers.pop()!;
            const newestIgnored = ignoredResolvers.pop()!;
            await act(async () => {
              newestList(ok(emptyChanges()));
              newestIgnored(ok(emptyIgnored()));
            });
            expect(container.textContent).toContain("Worktree is clean.");

            // Every older in-flight reply resolves late with stale dirty files.
            while (listResolvers.length > 0) {
              const staleList = listResolvers.pop()!;
              const staleIgnored = ignoredResolvers.pop()!;
              await act(async () => {
                staleList(ok(dirtyChanges(uniqueStale)));
                staleIgnored(
                  ok({
                    count: 5,
                    rules: [
                      {
                        source: ".git/info/exclude",
                        line: 1,
                        pattern: "*.log",
                        count: 5,
                        destination: "exclude"
                      }
                    ],
                    worktreeCount: 1
                  })
                );
              });
              expect(container.textContent).toContain("Worktree is clean.");
              for (const file of uniqueStale) {
                expect(container.textContent).not.toContain(file);
              }
            }
          } finally {
            act(() => root.unmount());
            root = createRoot(container);
          }
        }
      ),
      { numRuns: 15, seed: 2026112606 }
    );
  });

  it("retains ignored summary when switching between worktrees with identical ignored payloads", async () => {
    const ignoredPayload: IgnoredSummary = {
      count: 3,
      rules: [
        {
          source: ".git/info/exclude",
          line: 1,
          pattern: "*.tmp",
          count: 3,
          destination: "exclude"
        }
      ],
      worktreeCount: 1
    };
    mocks.dispatch.mockImplementation((name: string) => {
      if (name === "changes:list") return Promise.resolve(ok(emptyChanges()));
      if (name === "changes:ignoredSummary") return Promise.resolve(ok(structuredClone(ignoredPayload)));
      return Promise.resolve(ok(null));
    });

    const renderWt = (id: string) =>
      act(async () => {
        root.render(
          <ChangesTab
            worktree={{
              id,
              repoId: "repo-1",
              path: `/sandbox/repo-1/${id}`,
              branch: "main",
              dirty: 0,
              ahead: 0,
              behind: 0,
              behindDefault: 0,
              defaultBranch: "main",
              mergedIntoDefault: false,
              divergedFromDefault: false,
              isDefaultBranch: true,
              isPrimary: id === "wt-1",
              pinned: false
            }}
            activeEmail="test@example.test"
            activeFile={null}
            onOpenDiff={() => undefined}
            onOpenFileInsight={() => undefined}
          />
        );
      });

    await renderWt("wt-1");
    expect(container.textContent).toContain("3 untracked files hidden by ignore rules");

    await renderWt("wt-2");
    expect(container.textContent).toContain("3 untracked files hidden by ignore rules");
  });
});
