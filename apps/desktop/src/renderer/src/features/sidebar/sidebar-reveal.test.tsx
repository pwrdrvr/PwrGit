// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  requestSidebarReveal,
  settleSidebarReveal,
  useSidebarReveal,
  type SidebarReveal
} from "./sidebar-reveal";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

/** Mount a reader and hand back whatever it last saw. */
async function watch(): Promise<{
  current: () => SidebarReveal | null;
  unmount: () => Promise<void>;
}> {
  let seen: SidebarReveal | null = null;
  function Probe() {
    seen = useSidebarReveal();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  return {
    current: () => seen,
    unmount: () => act(async () => root.unmount())
  };
}

describe("sidebar-reveal", () => {
  it("holds a request until it is settled", async () => {
    const probe = await watch();
    await act(async () => requestSidebarReveal("repo-1", "upstream"));
    const request = probe.current();
    expect(request).toMatchObject({ repoId: "repo-1", remote: "upstream" });

    await act(async () => settleSidebarReveal(request!.seq));
    expect(probe.current()).toBeNull();
    await probe.unmount();
  });

  it("makes asking twice for the same place two requests", async () => {
    const probe = await watch();
    await act(async () => requestSidebarReveal("repo-1"));
    const first = probe.current();
    await act(async () => requestSidebarReveal("repo-1"));
    const second = probe.current();
    expect(second?.remote).toBeNull();
    expect(second?.seq).not.toBe(first?.seq);
    await act(async () => settleSidebarReveal(second!.seq));
    await probe.unmount();
  });

  it("never lets an old request's settle clear a newer one", async () => {
    const probe = await watch();
    await act(async () => requestSidebarReveal("repo-1", "upstream"));
    const stale = probe.current()!;
    await act(async () => requestSidebarReveal("repo-2"));
    await act(async () => settleSidebarReveal(stale.seq));
    expect(probe.current()).toMatchObject({ repoId: "repo-2", remote: null });
    await act(async () => settleSidebarReveal(probe.current()!.seq));
    await probe.unmount();
  });
});
