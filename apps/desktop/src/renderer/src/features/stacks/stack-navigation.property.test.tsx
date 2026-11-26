// @vitest-environment jsdom
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import fc from "fast-check";
import { ok } from "@pwrgit/shared";
import { expect, test, vi } from "vitest";
import { useStackPositionForPr, useStackSnapshot } from "./stack-navigation";

test("invalidation during a shared stack read publishes only a post-event snapshot", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("graph:changed", "pr:changed", "pr:openChanged", "stack:changed"), { minLength: 1, maxLength: 6 }),
      async channels => {
        const container = document.createElement("div");
        const root = createRoot(container);
        const events = new Map<string, Set<(payload: unknown) => void>>();
        const reads: ((schemaVersion: number) => void)[] = [];
        vi.stubGlobal("pwrgit", {
          dispatch: () => new Promise(resolve => reads.push(schemaVersion => resolve(ok({ schemaVersion, readOnly: false, stacks: [] })))),
          on: (channel: string, listener: (payload: unknown) => void) => {
            const listeners = events.get(channel) ?? new Set();
            listeners.add(listener);
            events.set(channel, listeners);
            return () => listeners.delete(listener);
          },
        });
        function Viewer() {
          const { snapshot } = useStackSnapshot("repo", "profile");
          return <span>{snapshot?.schemaVersion ?? "loading"}</span>;
        }
        try {
          await act(async () => root.render(<><Viewer /><Viewer /></>));
          expect(reads).toHaveLength(1);
          for (const channel of channels) {
            await act(async () => {
              for (const listener of events.get(channel) ?? []) listener({ repoId: "repo", profileId: "profile" });
              await vi.advanceTimersByTimeAsync(60);
            });
          }
          expect(reads).toHaveLength(1);
          await act(async () => reads[0](1));
          expect(container.textContent).toBe("loadingloading");
          expect(reads).toHaveLength(2);
          await act(async () => reads[1](2));
          expect(container.textContent).toBe("22");
          await act(async () => {
            for (const listener of events.get("stack:changed") ?? []) listener({ repoId: "repo", profileId: "other" });
            await vi.advanceTimersByTimeAsync(60);
          });
          expect(reads).toHaveLength(2);
        } finally {
          await act(async () => {
            root.unmount();
            for (const complete of reads) complete(2);
          });
        }
      }), { numRuns: 12, examples: [[["stack:changed"]]] });
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test("equivalent stack snapshots on focus or invalidation cause zero extra commits", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 6 }),
      async (focusCount) => {
        const container = document.createElement("div");
        const root = createRoot(container);
        const repoId = `repo-eq-${focusCount}`;
        const snapshot = { schemaVersion: 1, readOnly: false, stacks: [] };
        vi.stubGlobal("pwrgit", {
          dispatch: () => Promise.resolve(ok(structuredClone(snapshot))),
          on: () => () => undefined
        });
        let viewerCommits = 0;
        let chipCommits = 0;
        function Viewer() {
          useStackSnapshot(repoId, "profile");
          return null;
        }
        function Chip() {
          useStackPositionForPr(repoId, { number: 12 });
          return null;
        }
        try {
          await act(async () =>
            root.render(
              <>
                <Profiler id="viewer" onRender={() => { viewerCommits += 1; }}>
                  <Viewer />
                </Profiler>
                <Profiler id="chip" onRender={() => { chipCommits += 1; }}>
                  <Chip />
                </Profiler>
              </>
            )
          );
          const baseViewer = viewerCommits;
          const baseChip = chipCommits;
          for (let i = 0; i < focusCount; i++) {
            await act(async () => {
              window.dispatchEvent(new Event("focus"));
            });
          }
          expect(viewerCommits).toBe(baseViewer);
          expect(chipCommits).toBe(baseChip);
        } finally {
          await act(async () => root.unmount());
          vi.unstubAllGlobals();
        }
      }
    ),
    { numRuns: 12, seed: 2026112608 }
  );
});
