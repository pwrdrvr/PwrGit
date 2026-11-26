// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkSyncProgress, BulkSyncSummary, Repo } from "@pwrgit/shared";

const { dispatch, subscribe, displayPath } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn(),
  displayPath: vi.fn((p: string) => p)
}));
vi.mock("../../lib/pwrgit", () => ({ dispatch, subscribe }));
vi.mock("../../lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/platform")>();
  return {
    ...actual,
    displayPath: (p: string, platform?: string) => {
      displayPath(p);
      return actual.displayPath(p, platform);
    }
  };
});

import {
  BulkSyncDialog,
  type BulkSyncPresentation
} from "./BulkSyncDialog";

const makeRepos = (count: number): Repo[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `repo-${i}`,
    name: `service-${i}`,
    path: `/repos/service-${i}`,
    profileId: "profile-1",
    pinned: false,
    worktrees: []
  }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dispatch.mockReset();
  subscribe.mockReset();
  displayPath.mockReset();
  vi.useRealTimers();
});

describe("BulkSyncDialog expanded rendering isolation properties", () => {
  it("skips redundant toolbar progress publishes on livePath-only updates while dialog is open, and publishes latest state on minimize", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 3, max: 10 }),
        async (repoCount) => {
          vi.useFakeTimers({
            toFake: ["requestAnimationFrame", "cancelAnimationFrame"]
          });
          try {
            dispatch.mockClear();
            subscribe.mockClear();
            let emit: ((event: BulkSyncProgress) => void) | undefined;
            subscribe.mockImplementation(
              (_channel: string, handler: (event: BulkSyncProgress) => void) => {
                emit = handler;
                return vi.fn();
              }
            );
            dispatch.mockImplementation((command: string) =>
              command === "remote:bulkSync"
                ? new Promise<BulkSyncSummary>(() => undefined)
                : Promise.resolve({ ok: true, value: { cancelled: true } })
            );

            const repos = makeRepos(repoCount);
            const onProgress = vi.fn();
            let setViewExternal!: (next: BulkSyncPresentation) => void;

            function Harness() {
              const [view, setView] = useState<BulkSyncPresentation>("dialog");
              setViewExternal = setView;
              return (
                <BulkSyncDialog
                  profileId="profile-1"
                  repos={repos}
                  mode="soft-pull"
                  platform="darwin"
                  view={view}
                  onViewChange={setView}
                  onProgress={onProgress}
                  onClose={vi.fn()}
                />
              );
            }

            await act(async () => root.render(<Harness />));
            const operationId = dispatch.mock.calls.find(
              ([cmd]) => cmd === "remote:bulkSync"
            )![1].operationId as string;

            await act(async () => {
              emit?.({
                operationId,
                mode: "soft-pull",
                phase: "repo_started",
                totalRepos: repoCount,
                completedRepos: 0,
                repoId: "repo-0",
                repoName: "service-0"
              });
              vi.advanceTimersToNextFrame();
            });
            const callsAfterStart = onProgress.mock.calls.length;

            // Starting a second repo while dialog is open does not change
            // finished counts; behind-modal toolbar must not churn on
            // intermediate start/path-only ticks.
            await act(async () => {
              emit?.({
                operationId,
                mode: "soft-pull",
                phase: "repo_started",
                totalRepos: repoCount,
                completedRepos: 0,
                repoId: "repo-1",
                repoName: "service-1"
              });
              vi.advanceTimersToNextFrame();
            });
            const callsAfterSecondStart = onProgress.mock.calls.length;
            expect(callsAfterSecondStart).toBe(callsAfterStart);

            // Minimizing to toast immediately publishes the live fold.
            await act(async () => {
              setViewExternal("toast");
            });
            expect(onProgress.mock.calls.length).toBeGreaterThan(
              callsAfterSecondStart
            );
            expect(onProgress).toHaveBeenLastCalledWith(
              expect.objectContaining({
                inFlight: 2,
                queued: repoCount - 2,
                path: "/repos/service-1 · +1 more"
              })
            );
          } finally {
            await act(async () => root.unmount());
            root = createRoot(container);
            vi.useRealTimers();
          }
        }
      ),
      { numRuns: 10 }
    );
  });

  it("re-renders only the mutated repository card during expanded progress frames", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 5, max: 16 }),
        fc.integer({ min: 0, max: 15 }),
        async (repoCount, rawTarget) => {
          vi.useFakeTimers({
            toFake: ["requestAnimationFrame", "cancelAnimationFrame"]
          });
          try {
            dispatch.mockClear();
            subscribe.mockClear();
            displayPath.mockClear();
            const targetIdx = rawTarget % repoCount;
            const targetId = `repo-${targetIdx}`;
            let emit: ((event: BulkSyncProgress) => void) | undefined;
            subscribe.mockImplementation(
              (_channel: string, handler: (event: BulkSyncProgress) => void) => {
                emit = handler;
                return vi.fn();
              }
            );
            dispatch.mockImplementation((command: string) =>
              command === "remote:bulkSync"
                ? new Promise<BulkSyncSummary>(() => undefined)
                : Promise.resolve({ ok: true, value: { cancelled: true } })
            );

            const repos = makeRepos(repoCount);
            await act(async () =>
              root.render(
                <BulkSyncDialog
                  profileId="profile-1"
                  repos={repos}
                  mode="soft-pull"
                  platform="darwin"
                  view="dialog"
                  onClose={vi.fn()}
                />
              )
            );
            const operationId = dispatch.mock.calls.find(
              ([cmd]) => cmd === "remote:bulkSync"
            )![1].operationId as string;

            await act(async () => {
              emit?.({
                operationId,
                mode: "soft-pull",
                phase: "repo_started",
                totalRepos: repoCount,
                completedRepos: 0,
                repoId: targetId,
                repoName: `service-${targetIdx}`
              });
              vi.advanceTimersToNextFrame();
            });

            // Detail update for ONLY targetId: only targetId's card (+ livePathLine)
            // may format its path, never all N sibling cards.
            displayPath.mockClear();
            await act(async () => {
              emit?.({
                operationId,
                mode: "soft-pull",
                phase: "repo_progress",
                totalRepos: repoCount,
                completedRepos: 0,
                repoId: targetId,
                repoName: `service-${targetIdx}`,
                detail: "Fetching origin…"
              });
              vi.advanceTimersToNextFrame();
            });
            expect(displayPath).toHaveBeenCalledTimes(2);
            expect(
              displayPath.mock.calls.every(
                ([p]) => p === `/repos/service-${targetIdx}`
              )
            ).toBe(true);
          } finally {
            await act(async () => root.unmount());
            root = createRoot(container);
            vi.useRealTimers();
          }
        }
      ),
      { numRuns: 10 }
    );
  });
});
