// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ok, type EventPayload } from "@pwrgit/shared";
import { ToastHost } from "./ToastHost";
import { dismissToast, showInfoToast, subscribeToasts, type Toast } from "../../lib/toast";

const bridge = vi.hoisted(() => ({ listeners: new Map<string, (payload: unknown) => void>() }));
vi.mock("../../lib/pwrgit", () => ({
  dispatch: vi.fn(async () => ok(undefined)),
  subscribe: (channel: string, handler: (payload: unknown) => void) => {
    bridge.listeners.set(channel, handler);
    return () => bridge.listeners.delete(channel);
  }
}));
vi.mock("../update/AppUpdateToast", () => ({ AppUpdateToast: () => null }));
vi.mock("../remote/RemoteActivityToast", () => ({ RemoteActivityToast: () => null }));
vi.mock("../settings/CodexVersionNotice", () => ({ CodexVersionNotice: () => null }));
vi.mock("../identity/GitIdentityNotice", () => ({ GitIdentityNotice: () => null }));

function capture(index: number, profileId: string | null): EventPayload<"diagnostics:cpuProfileCaptured"> {
  return {
    profileId, target: profileId === null ? "main" as const : "renderer" as const,
    capturedAt: "2026-11-16T12:00:00.000Z", heapSnapshotArtifacts: [],
    sourceHostname: "cpu-lab.example",
    profileFilename: "cpu-0001.cpuprofile", // Same basename in different sessions.
    profilePath: `/demo/hot-cpu-${index}/cpu-0001.cpuprofile`,
    sessionDirectory: `/demo/hot-cpu-${index}`, sessionDirectoryName: `hot-cpu-${index}`,
    triggerConsecutiveSamples: 1, triggerCpuPercent: 75,
    triggerMode: "spike" as const, triggerThresholdPercent: 50
  };
}
function emitCapture(event: ReturnType<typeof capture>) {
  bridge.listeners.get("diagnostics:cpuProfileCaptured")?.(event);
}

let container: HTMLDivElement;
let root: Root;
let current: Toast[] = [];
let unsubscribe: () => void;
function clear() { for (const toast of current) dismissToast(toast.id); }
beforeEach(() => {
  vi.useFakeTimers();
  unsubscribe = subscribeToasts((toasts) => { current = toasts; });
  clear();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); clear(); });
  unsubscribe(); container.remove(); vi.useRealTimers(); vi.restoreAllMocks();
});

it("retains every own-profile and app-wide capture until explicit dismissal and never merges different sessions", async () => {
  await act(async () => root.render(<ToastHost profileId="profile-a" repos={[]} onReveal={() => {}} />));
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (count) => {
    await act(async () => {
      clear();
      for (let index = 0; index < count; index++) {
        const event = capture(index, index % 2 === 0 ? null : "profile-a");
        emitCapture(event); emitCapture(event); // Re-delivery is idempotent.
      }
      emitCapture(capture(999, "profile-b"));
    });
    expect(current).toHaveLength(count);
    expect(new Set(current.map((toast) => toast.key)).size).toBe(count);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(current).toHaveLength(count);
    expect(container.querySelectorAll('[data-toast-group="hot-cpu-profile"]')).toHaveLength(1);
    expect(container.querySelectorAll(".app-toast__timer")).toHaveLength(0);
  }), { numRuns: 12 });
});

it("pages and dismisses CPU captures as a group without clearing other notices or suppressing future captures", async () => {
  await act(async () => root.render(<ToastHost profileId="profile-a" repos={[]} onReveal={() => {}} />));
  await fc.assert(fc.asyncProperty(fc.integer({ min: 3, max: 8 }), async (count) => {
    await act(async () => {
      clear();
      showInfoToast({ key: "unrelated", title: "Other durable notice", message: "Keep this", sticky: true, dismissGroup: { key: "hot-cpu-profile-other", label: "Other notices" } });
      for (let index = 0; index < count; index++) emitCapture(capture(index, null));
    });
    const cpuCard = () => container.querySelector<HTMLElement>('[data-toast-group="hot-cpu-profile"]')!;
    const button = (label: string) => [...cpuCard().querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label)!;
    expect(cpuCard()).not.toBeNull();
    expect(cpuCard().textContent).toContain(`1 of ${count}`);
    for (let i = 1; i < count; i++) await act(async () => button("Next notice").click());
    expect(cpuCard().textContent).toContain(`${count} of ${count}`);
    expect(cpuCard().textContent).toContain(`hot-cpu-${count - 1}`);
    await act(async () => button("Dismiss notice").click());
    expect(current.filter((toast) => toast.key !== "unrelated")).toHaveLength(count - 1);
    expect(cpuCard().textContent).toContain(`${count - 1} of ${count - 1}`);
    await act(async () => button("Dismiss all CPU profile notices").click());
    expect(current.map((toast) => toast.key)).toEqual(["unrelated"]);
    await act(async () => emitCapture(capture(1000, null)));
    expect(current).toHaveLength(2);
    expect(cpuCard()).not.toBeNull();
    expect(button("Dismiss all CPU profile notices")).toBeUndefined();
  }), { numRuns: 12 });
});

it("copies PwrAgnt-style capture details without dismissing the notice", async () => {
  const writeText = vi.fn(async (_value: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const event = capture(1, null);
  event.heapSnapshotArtifacts = [{ phase: "start", filename: "heap.heapsnapshot", path: "/demo/hot-cpu-1/heap.heapsnapshot" }];
  try {
    await act(async () => {
      root.render(<ToastHost profileId="profile-a" repos={[]} onReveal={() => {}} />);
    });
    await act(async () => emitCapture(event));
    const copy = container.querySelector<HTMLButtonElement>('[aria-label="Copy notice"]')!;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(event.profilePath));
    expect(writeText.mock.calls[0]?.[0]).toContain(event.sessionDirectory);
    expect(writeText.mock.calls[0]?.[0]).toContain(event.heapSnapshotArtifacts[0]!.path);
    expect(writeText.mock.calls[0]?.[0]).toContain("Source: Local app on cpu-lab.example");
    expect(writeText.mock.calls[0]?.[0]).toContain(`CPU profile basename: ${event.profileFilename}`);
    expect(container.querySelector("dt")?.textContent).toBe("Source");
    expect(current).toHaveLength(1);
  } finally { Reflect.deleteProperty(navigator, "clipboard"); }
});

it("uses PwrAgnt's compact icon controls and short group dismissal label", async () => {
  await act(async () => root.render(<ToastHost profileId="profile-a" repos={[]} onReveal={() => {}} />));
  await act(async () => { emitCapture(capture(1, null)); emitCapture(capture(2, null)); });
  const card = container.querySelector('[data-toast-group="hot-cpu-profile"]')!;
  for (const label of ["Previous notice", "Next notice", "Copy notice", "Dismiss notice"]) {
    const button = card.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    expect(button, label).not.toBeNull();
    expect(button!.textContent, label).toBe("");
    expect(button!.querySelector("svg"), label).not.toBeNull();
  }
  expect(card.querySelector('[aria-label="Dismiss all CPU profile notices"]')?.textContent).toBe("Dismiss all");
});
