// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ok, type CloneCatalog } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: () => () => undefined
}));
import { ForkRepoDialog } from "./ForkRepoDialog";

it("preserves a search typed before the catalog chooses the usable forge", async () => {
  vi.useFakeTimers();
  let resolveCatalog!: (value: ReturnType<typeof ok<CloneCatalog>>) => void;
  const catalog = new Promise<ReturnType<typeof ok<CloneCatalog>>>((resolve) => {
    resolveCatalog = resolve;
  });
  dispatchMock.mockImplementation((channel: string) => {
    if (channel === "repo:cloneCatalog") return catalog;
    if (channel === "forge:hosts") return Promise.resolve(ok({ overrides: {} }));
    return Promise.resolve(ok([]));
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ForkRepoDialog
        profile={{
          id: "p", name: "Test", email: "test@example.com", mono: "T",
          roots: [], onboardingCompleted: true
        }}
        onForked={() => undefined}
        onReveal={() => undefined}
        onClose={() => undefined}
      />
    ));
    const input = container.querySelector<HTMLInputElement>("#fork-source")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!.call(input, "upstream/team/repo");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => resolveCatalog(ok({ owners: [], forges: [{
      kind: "gitlab", cli: "glab", installed: true, loggedIn: true,
      capabilities: {
        batchedBranchLookup: true, batchedCommitAssociation: true,
        changeSizeAndTimeline: true, commitAuthorIdentity: true,
        forkDefaultBranchOnly: false
      },
      hosts: [{ host: "gitlab.com", enabled: true, loggedIn: true }]
    }] })));
    expect(input.value).toBe("upstream/team/repo");
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(dispatchMock).toHaveBeenCalledWith("repo:searchCloneSources", {
      profileId: "p", query: "upstream/team/repo", host: "gitlab"
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.resetAllMocks();
  }
});
