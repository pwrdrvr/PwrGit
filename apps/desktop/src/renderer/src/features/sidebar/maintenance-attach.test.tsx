// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_MAINTENANCE_RUN_VIEW,
  type MaintenanceCurrent,
  type MaintenanceRunRecord,
  type MaintenanceSummary
} from "@pwrgit/shared";

const { dispatch, subscribe } = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({ dispatch, subscribe }));
import { useReopenMaintenanceAfterReload } from "./maintenance-attach";

const run: MaintenanceRunRecord = {
  operationId: "op",
  profileId: "one",
  allProfiles: false,
  action: { kind: "reshare", updateMain: true },
  startedAt: "2026-11-04T12:00:00Z",
  ownWindow: true
};
const summary: MaintenanceSummary = { operationId: "op", startedAt: run.startedAt, finishedAt: run.startedAt, cancelled: false, results: [] };

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

function Probe({ profileId, open }: { profileId: string | undefined; open: () => void }) {
  useReopenMaintenanceAfterReload(profileId, open);
  return null;
}

/** A fresh Sidebar, as a reload makes: the question is asked once per mount. */
async function mount(current: MaintenanceCurrent, profileId?: string): Promise<ReturnType<typeof vi.fn>> {
  act(() => root.unmount());
  root = createRoot(container);
  dispatch.mockResolvedValue({ ok: true, value: current });
  const open = vi.fn();
  await act(async () => root.render(<Probe profileId={profileId} open={open} />));
  return open;
}
const live: MaintenanceCurrent = { state: "running", run, view: EMPTY_MAINTENANCE_RUN_VIEW, cancelling: false };

describe("the Sidebar reopening Maintenance after a reload", () => {
  it("reopens for this window's live run, or its finished run nobody has seen", async () => {
    expect(await mount(live, "one")).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith("maintenance:current", { profileId: "one" });
    expect(await mount({ state: "finished", run, summary, seen: false }, "one")).toHaveBeenCalledOnce();
  });

  it("stays shut for a seen receipt, another window's run, nothing, or no profile yet", async () => {
    expect(await mount({ state: "finished", run, summary, seen: true }, "one")).not.toHaveBeenCalled();
    expect(await mount({ ...live, run: { ...run, ownWindow: false } }, "one")).not.toHaveBeenCalled();
    expect(await mount(null, "one")).not.toHaveBeenCalled();
    dispatch.mockClear();
    // No profile yet: nothing to ask about.
    expect(await mount(live)).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not open after the Sidebar is gone", async () => {
    let answer!: (value: unknown) => void;
    dispatch.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const open = vi.fn();
    await act(async () => root.render(<Probe profileId="one" open={open} />));
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => answer({ ok: true, value: { state: "running", run, view: EMPTY_MAINTENANCE_RUN_VIEW, cancelling: false } }));
    expect(open).not.toHaveBeenCalled();
  });
});
