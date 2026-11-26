// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { ok, type Repo } from "@pwrgit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderCounts = new Map<string, number>();

vi.mock("../../lib/pwrgit", () => ({
  dispatch: vi.fn((name: string) => {
    if (name === "repo:hiddenList") return Promise.resolve(ok([]));
    if (name === "remote:activities") return Promise.resolve(ok([]));
    if (name === "settings:read") {
      return Promise.resolve(ok({ general: { tagCheckAfterSync: false } }));
    }
    if (name === "forge:hosts") {
      return Promise.resolve(ok({ hosts: [], overrides: {} }));
    }
    return Promise.resolve(ok(null));
  }),
  subscribe: vi.fn(() => () => undefined),
  windowProfileId: () => "personal"
}));
vi.mock("./RepoRow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./RepoRow")>();
  return {
    ...actual,
    RepoRow: (props: Parameters<typeof actual.RepoRow>[0]) => {
      renderCounts.set(props.repo.id, (renderCounts.get(props.repo.id) ?? 0) + 1);
      return <div className="repo-row" data-repo-id={props.repo.id}>{props.repo.name}</div>;
    }
  };
});

import { Sidebar } from "./Sidebar";

const makeRepo = (i: number, behind = 0): Repo => ({
  id: `repo-${i}`,
  name: `repo-${i}`,
  path: `/sandbox/repo-${i}`,
  profileId: "personal",
  pinned: false,
  worktrees: [
    {
      id: `wt-${i}-0`,
      repoId: `repo-${i}`,
      path: `/sandbox/repo-${i}`,
      branch: "main",
      isPrimary: true,
      isDefaultBranch: true,
      pinned: false,
      dirty: 1,
      ahead: 0,
      behind,
      behindDefault: 0,
      defaultBranch: "main",
      mergedIntoDefault: false,
      divergedFromDefault: false
    }
  ]
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  renderCounts.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Sidebar RepoRow memoization properties", () => {
  it("re-renders only the mutated repository when sibling Repo references stay unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 4, max: 12 }),
        fc.integer({ min: 0, max: 11 }),
        async (repoCount, targetRaw) => {
          localStorage.clear();
          renderCounts.clear();
          const targetIdx = targetRaw % repoCount;
          const repos = Array.from({ length: repoCount }, (_, i) => makeRepo(i, 0));

          const renderSidebar = (list: Repo[]) =>
            act(async () => {
              root.render(
                <Sidebar
                  profiles={[
                    {
                      id: "personal",
                      name: "Personal",
                      email: "rowan@vale.example",
                      mono: "P",
                      roots: [],
                      onboardingCompleted: true,
                      showInMenu: true
                    }
                  ]}
                  activeProfile={{
                    id: "personal",
                    name: "Personal",
                    email: "rowan@vale.example",
                    mono: "P",
                    roots: [],
                    onboardingCompleted: true,
                    showInMenu: true
                  }}
                  profileLoadState={{ status: "ready" }}
                  onRetryProfiles={() => undefined}
                  onSwitchProfile={() => undefined}
                  onNewProfile={() => undefined}
                  onManageProfile={() => undefined}
                  repos={list}
                  repoLoadState={{ status: "ready" }}
                  onRetryRepos={() => undefined}
                  selectedWorktreeId={list[0]!.worktrees[0]!.id}
                  onSelectWorktree={() => undefined}
                  onSetRepoPin={() => undefined}
                  onSetWorktreePin={() => undefined}
                  onSetBranchPin={() => undefined}
                  onRemoveWorktree={() => undefined}
                  onCreateWorktree={() => Promise.resolve(null)}
                  onRemoveWorktrees={() => Promise.resolve({ removed: [], keptDirty: [], failed: [] })}
                  onPersistOrder={() => undefined}
                  onPersistRepoOrder={() => undefined}
                  onRefreshPullRequest={() => undefined}
                  onRefreshRepo={() => undefined}
                  refreshingRepoIds={new Set()}
                  onAddFolder={() => undefined}
                  onFindRepositories={() => undefined}
                  onRescanFolders={() => undefined}
                  onExpandRepo={() => undefined}
                  onCloneRepo={() => undefined}
                  onForkRepo={() => undefined}
                  onForkCheckout={() => undefined}
                />
              );
            });

          try {
            await renderSidebar(repos);
            // Switch to the All lens tab so every repo is rendered regardless of focus pagination.
            const allLensBtn = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((btn) =>
              (btn.getAttribute("aria-label") ?? "").startsWith("All")
            );
            expect(allLensBtn).toBeDefined();
            await act(async () => allLensBtn!.click());
            const beforeCounts = new Map(renderCounts);
            for (let i = 0; i < repoCount; i++) {
              expect(beforeCounts.get(`repo-${i}`) ?? 0).toBeGreaterThan(0);
            }

            // Mutate ONLY one repo (simulating mergeChangedRepos during bulk sync).
            const updated = repos.map((repo, index) =>
              index === targetIdx ? makeRepo(index, 3) : repo
            );
            await renderSidebar(updated);

            for (let i = 0; i < repoCount; i++) {
              const id = `repo-${i}`;
              const delta = (renderCounts.get(id) ?? 0) - (beforeCounts.get(id) ?? 0);
              if (i === targetIdx) {
                expect(delta).toBe(1);
              } else {
                expect(delta).toBe(0);
              }
            }
          } finally {
            act(() => root.unmount());
            root = createRoot(container);
          }
        }
      ),
      { numRuns: 10, seed: 2026112612 }
    );
  });
});
