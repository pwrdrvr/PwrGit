// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import fc from "fast-check";
import { ok } from "@pwrgit/shared";
import { expect, test, vi } from "vitest";
import { useStackSnapshot } from "./stack-navigation";

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
