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

it("forks the seeded checkout in place, and only while it is the source", async () => {
  const source = {
    name: "diskhound", owner: "tzarebczan",
    nameWithOwner: "tzarebczan/diskhound", visibility: "public" as const,
    host: "github" as const, hostname: "github.com",
    sshUrl: "", httpsUrl: "", localPaths: []
  };
  dispatchMock.mockImplementation((channel: string) => {
    if (channel === "repo:cloneCatalog") {
      return Promise.resolve(ok({ owners: [], forges: [{
        kind: "github", cli: "gh", installed: true, loggedIn: true,
        capabilities: {
          batchedBranchLookup: true, batchedCommitAssociation: true,
          changeSizeAndTimeline: true, commitAuthorIdentity: true,
          forkDefaultBranchOnly: true
        },
        hosts: [{ host: "github.com", enabled: true, loggedIn: true }]
      }] }));
    }
    if (channel === "forge:hosts") return Promise.resolve(ok({ overrides: {} }));
    if (channel === "repo:forkTargets") {
      return Promise.resolve(ok([{ login: "huntharo", kind: "user", host: "github" }]));
    }
    if (channel === "repo:forkCheckoutPreflight") {
      return Promise.resolve(ok({
        fork: {
          source,
          target: { owner: "huntharo", name: "diskhound", nameWithOwner: "huntharo/diskhound" },
          upstreamChoices: [
            { nameWithOwner: "tzarebczan/diskhound", url: "https://github.com/tzarebczan/diskhound" }
          ]
        },
        origin: {
          url: "git@github.com:tzarebczan/diskhound.git",
          nameWithOwner: "tzarebczan/diskhound"
        },
        protocol: "ssh",
        upstreamRemote: { name: "upstream", existing: false },
        upstreamFor: "tzarebczan/diskhound"
      }));
    }
    // The clone-shaped question stays in flight: in place it must not be
    // asked at all, and after opting out it is enough that it was.
    if (channel === "repo:forkPreflight") return new Promise(() => undefined);
    if (channel === "repo:forkCheckout") return new Promise(() => undefined);
    return Promise.resolve(ok([]));
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const submit = () =>
    container.querySelector<HTMLButtonElement>(".clone-dialog__submit")!;
  try {
    await act(async () => root.render(
      <ForkRepoDialog
        profile={{
          id: "p", name: "Test", email: "test@example.com", mono: "T",
          roots: [], onboardingCompleted: true
        }}
        initialSource={source}
        inPlace={{ repoId: "r1", repoName: "diskhound" }}
        onForked={() => undefined}
        onReveal={() => undefined}
        onClose={() => undefined}
      />
    ));
    // In place by default: the button says so, nothing asks how or where to
    // clone, and the remote layout it will write is on screen.
    expect(container.querySelector(".fork-in-place")?.textContent).toContain(
      "Forking this checkout in place: diskhound"
    );
    expect(submit().textContent).toBe("Fork in place");
    expect(container.querySelector("#fork-destination")).toBeNull();
    expect(
      [...container.querySelectorAll(".fork-remote-plan__name")].map((n) => n.textContent)
    ).toEqual(["origin", "upstream"]);
    expect(dispatchMock).toHaveBeenCalledWith(
      "repo:forkCheckoutPreflight",
      expect.objectContaining({ profileId: "p", repoId: "r1", targetOwner: "huntharo" })
    );
    expect(
      dispatchMock.mock.calls.some(([channel]) => channel === "repo:forkPreflight")
    ).toBe(false);

    await act(async () => submit().click());
    expect(dispatchMock).toHaveBeenCalledWith(
      "repo:forkCheckout",
      expect.objectContaining({
        repoId: "r1",
        targetOwner: "huntharo",
        targetOwnerKind: "user",
        targetName: "diskhound",
        upstream: "tzarebczan/diskhound"
      })
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.resetAllMocks();
  }

  // A fresh dialog for the way out, since the first is now mid-fork.
  dispatchMock.mockImplementation((channel: string) => {
    if (channel === "repo:cloneCatalog") return Promise.resolve(ok({ owners: [], forges: [] }));
    if (channel === "forge:hosts") return Promise.resolve(ok({ overrides: {} }));
    if (channel === "repo:forkPreflight") return new Promise(() => undefined);
    if (channel === "repo:forkCheckoutPreflight") return new Promise(() => undefined);
    return Promise.resolve(ok([]));
  });
  const container2 = document.createElement("div");
  document.body.append(container2);
  const root2 = createRoot(container2);
  const buttonNamed2 = (name: string) =>
    [...container2.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === name
    );
  try {
    await act(async () => root2.render(
      <ForkRepoDialog
        profile={{
          id: "p", name: "Test", email: "test@example.com", mono: "T",
          roots: [], onboardingCompleted: true
        }}
        initialSource={source}
        inPlace={{ repoId: "r1", repoName: "diskhound" }}
        onForked={() => undefined}
        onReveal={() => undefined}
        onClose={() => undefined}
      />
    ));
    // Opting out restores today's dialog, with the way back offered.
    await act(async () => buttonNamed2("Clone a separate copy instead")?.click());
    expect(container2.querySelector(".fork-in-place")?.textContent).toContain(
      "Already checked out here, as diskhound"
    );
    expect(container2.querySelector("#fork-destination")).not.toBeNull();
    expect(
      container2.querySelector<HTMLButtonElement>(".clone-dialog__submit")!.textContent
    ).toBe("Fork & clone");
    expect(
      dispatchMock.mock.calls.some(([channel]) => channel === "repo:forkPreflight")
    ).toBe(true);
    await act(async () => buttonNamed2("Fork in place")?.click());
    expect(container2.querySelector("#fork-destination")).toBeNull();

    // Searching for something else leaves that checkout out of it.
    const input = container2.querySelector<HTMLInputElement>("#fork-source")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!.call(input, "someone/else");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container2.querySelector(".fork-in-place")).toBeNull();
  } finally {
    await act(async () => root2.unmount());
    container2.remove();
    vi.resetAllMocks();
  }
});
