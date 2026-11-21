// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ok, type EventPayload, type StartupCpuProfileCapturedEvent } from "@pwrgit/shared";
import { ToastHost } from "./ToastHost";
import { dismissToast, subscribeToasts, type Toast } from "../../lib/toast";

const bridge = vi.hoisted(() => ({
  listeners: new Map<string, (payload: unknown) => void>(),
  pending: null as unknown,
  readGate: Promise.resolve()
}));
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch,
  subscribe: (channel: string, handler: (payload: unknown) => void) => {
    bridge.listeners.set(channel, handler);
    return () => bridge.listeners.delete(channel);
  }
}));
vi.mock("../update/AppUpdateToast", () => ({ AppUpdateToast: () => null }));
vi.mock("../remote/RemoteActivityToast", () => ({ RemoteActivityToast: () => null }));
vi.mock("../settings/CodexVersionNotice", () => ({ CodexVersionNotice: () => null }));
vi.mock("../identity/GitIdentityNotice", () => ({ GitIdentityNotice: () => null }));

const DIR = "/demo/PwrGit/diagnostics/startup-cpu-2026-11-20-1843-a1b2c3";
function startup(status: StartupCpuProfileCapturedEvent["status"]): StartupCpuProfileCapturedEvent {
  const rendererSaved = status === "completed";
  return {
    sessionId: "a1b2c3", sessionDirectory: DIR, sessionDirectoryName: "startup-cpu-2026-11-20-1843-a1b2c3",
    status, reason: rendererSaved ? "post-load-elapsed" : "hard-timeout", armedBy: "settings",
    startedAt: "2026-11-20T18:43:08.000Z", completedAt: "2026-11-20T18:43:14.000Z",
    sourceHostname: "lab-mac.example",
    artifacts: [
      { kind: "main-profile", filename: "main.cpuprofile", path: `${DIR}/main.cpuprofile` },
      ...(rendererSaved ? [{ kind: "renderer-profile" as const, filename: "renderer.cpuprofile", path: `${DIR}/renderer.cpuprofile` }] : []),
      { kind: "manifest", filename: "session.json", path: `${DIR}/session.json` },
      { kind: "events", filename: "events.ndjson", path: `${DIR}/events.ndjson` }
    ],
    missing: rendererSaved ? [] : ["renderer-profile"]
  };
}
function hotCapture(): EventPayload<"diagnostics:cpuProfileCaptured"> {
  return {
    profileId: null, target: "main", capturedAt: "2026-11-20T18:50:00.000Z", heapSnapshotArtifacts: [],
    profileFilename: "cpu-0001.cpuprofile", profilePath: "/demo/hot-cpu-1/cpu-0001.cpuprofile",
    sessionDirectory: "/demo/hot-cpu-1", sessionDirectoryName: "hot-cpu-1",
    triggerConsecutiveSamples: 1, triggerCpuPercent: 75, triggerMode: "spike", triggerThresholdPercent: 50
  };
}
const emit = (channel: string, payload: unknown) => bridge.listeners.get(channel)?.(payload);

let container: HTMLDivElement;
let root: Root;
let current: Toast[] = [];
let unsubscribe: () => void;
beforeEach(() => {
  unsubscribe = subscribeToasts((toasts) => { current = toasts; });
  for (const toast of current) dismissToast(toast.id);
  bridge.pending = null;
  bridge.readGate = Promise.resolve();
  dispatch.mockReset();
  dispatch.mockImplementation(async (name: string) => {
    if (name === "diagnostics:readStartupCpuProfile") {
      await bridge.readGate;
      return ok(bridge.pending);
    }
    return ok(null);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  for (const toast of current) dismissToast(toast.id);
  unsubscribe();
  container.remove();
});

const startupCards = () => container.querySelectorAll('[data-toast-group="startup-cpu-profile"]');

it("shows one startup notice whether the window mounted before, during or after the capture finished", async () => {
  await fc.assert(fc.asyncProperty(
    // Where completion lands relative to this window: before mount (only the
    // read sees it), while the read is in flight, or after (only the broadcast).
    fc.constantFrom("before-mount", "during-read", "after-mount"),
    fc.constantFrom<StartupCpuProfileCapturedEvent["status"]>("completed", "partial"),
    fc.integer({ min: 1, max: 3 }),
    async (timing, status, broadcasts) => {
      await act(async () => { root.unmount(); });
      for (const toast of current) dismissToast(toast.id);
      root = createRoot(container);
      const event = startup(status);
      let openRead!: () => void;
      bridge.readGate = timing === "during-read" ? new Promise((resolve) => { openRead = resolve; }) : Promise.resolve();
      bridge.pending = timing === "before-mount" ? event : null;
      await act(async () => root.render(<ToastHost profileId="profile-a" repos={[]} onReveal={() => {}} />));
      await act(async () => {
        if (timing !== "before-mount") {
          bridge.pending = event;
          for (let i = 0; i < broadcasts; i++) emit("diagnostics:startupCpuProfileCaptured", event);
        }
        if (timing === "during-read") openRead();
      });
      expect(startupCards()).toHaveLength(1);
      expect(current.filter((toast) => toast.key === "startup-cpu-profile:a1b2c3")).toHaveLength(1);
      const card = startupCards()[0]!;
      expect(card.textContent).toContain(status === "completed" ? "Startup CPU profile saved" : "Startup CPU profile partly saved");
      expect(card.textContent).toContain(event.sessionDirectoryName);
      if (status === "partial") expect(card.textContent).toContain("renderer.cpuprofile missing");
    }
  ), { numRuns: 18 });
});

it("copies the session and every artifact path, and stays distinct from hot CPU captures", async () => {
  const writeText = vi.fn(async (_value: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    const event = startup("partial");
    await act(async () => root.render(<ToastHost profileId="profile-a" repos={[]} onReveal={() => {}} />));
    await act(async () => {
      emit("diagnostics:cpuProfileCaptured", hotCapture());
      emit("diagnostics:startupCpuProfileCaptured", event);
    });
    expect(container.querySelectorAll('[data-toast-group="hot-cpu-profile"]')).toHaveLength(1);
    expect(startupCards()).toHaveLength(1);
    const copy = startupCards()[0]!.querySelector<HTMLButtonElement>('[aria-label="Copy notice"]')!;
    await act(async () => copy.click());
    const copied = writeText.mock.calls[0]![0];
    expect(copied).toContain("startup CPU profile (partial)");
    expect(copied).toContain(`Session directory path: ${DIR}`);
    for (const artifact of event.artifacts) expect(copied).toContain(artifact.path);
    expect(copied).toContain("Not captured: renderer.cpuprofile");
    expect(copied).not.toContain("Trigger:");
    expect(startupCards()).toHaveLength(1); // Copy does not dismiss.
  } finally { Reflect.deleteProperty(navigator, "clipboard"); }
});

it("dismissing tells main, and a dismissal from another window takes this card down", async () => {
  bridge.pending = startup("completed");
  await act(async () => root.render(<ToastHost profileId="profile-a" repos={[]} onReveal={() => {}} />));
  expect(startupCards()).toHaveLength(1);
  await act(async () => startupCards()[0]!.querySelector<HTMLButtonElement>('[aria-label="Dismiss notice"]')!.click());
  expect(dispatch).toHaveBeenCalledWith("diagnostics:dismissStartupCpuProfile", { sessionId: "a1b2c3" });
  expect(startupCards()).toHaveLength(0);

  await act(async () => emit("diagnostics:startupCpuProfileCaptured", startup("completed")));
  expect(startupCards()).toHaveLength(1);
  await act(async () => emit("diagnostics:startupCpuProfileDismissed", { sessionId: "a1b2c3" }));
  expect(startupCards()).toHaveLength(0);
});
