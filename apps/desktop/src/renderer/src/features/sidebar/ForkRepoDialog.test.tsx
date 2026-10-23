// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { forgeCapabilities, ok, type CloneCatalog } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: () => () => undefined
}));
import { ForkRepoDialog } from "./ForkRepoDialog";

it.each(["empty", "seeded", "in-place", "pasted"])("excludes Artifacts from fork APIs for an %s source", async (mode) => {
  vi.useFakeTimers();
  const hostname = "0123456789abcdef0123456789abcdef.artifacts.cloudflare.net";
  const source = {
    name: "demo", owner: "default", nameWithOwner: "default/demo",
    visibility: "unknown" as const, host: "artifacts" as const, hostname,
    sshUrl: "", httpsUrl: `https://${hostname}/git/default/demo.git`, localPaths: []
  };
  dispatchMock.mockImplementation((channel: string) => {
    if (channel === "repo:cloneCatalog") return Promise.resolve(ok({ owners: [], forges: [
      { kind: "github", cli: "gh", installed: true, loggedIn: true, capabilities: forgeCapabilities("github"), hosts: [{ host: "github.com", enabled: true, loggedIn: true }] },
      { kind: "gitlab", cli: "glab", installed: true, loggedIn: true, capabilities: forgeCapabilities("gitlab"), hosts: [{ host: "gitlab.com", enabled: true, loggedIn: true }] },
      { kind: "artifacts", cli: "", installed: true, loggedIn: true, capabilities: forgeCapabilities("artifacts"), hosts: [{ host: hostname, enabled: true, loggedIn: true }] }
    ] }));
    if (channel === "forge:hosts") return Promise.resolve(ok({ overrides: { [hostname]: "artifacts" } }));
    return Promise.resolve(ok([]));
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ForkRepoDialog
      profile={{ id: "p", name: "Test", email: "test@example.com", mono: "T", roots: [], onboardingCompleted: true, showInMenu: true }}
      {...(mode === "seeded" || mode === "in-place" ? { initialSource: source } : {})}
      {...(mode === "in-place" ? { inPlace: { repoId: "r1", repoName: "demo" } } : {})}
      onForked={() => undefined} onReveal={() => undefined} onClose={() => undefined}
    />));
    if (mode === "pasted") await act(async () => {
      const input = container.querySelector<HTMLInputElement>("#fork-source")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, source.httpsUrl);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTime(300));
    expect([...container.querySelectorAll(".fork-host")].map((button) => button.textContent)).toEqual(["GitHub", "GitLab"]);
    expect(dispatchMock.mock.calls.some(([channel, payload]) =>
      ["repo:forkTargets", "repo:searchCloneSources", "repo:forkPreflight", "repo:forkCheckoutPreflight"].includes(channel) &&
      (payload?.host === "artifacts" || channel === "repo:forkCheckoutPreflight")
    )).toBe(false);
    if (mode !== "empty") {
      expect(container.textContent).toContain("Cloudflare Artifacts does not support forks in PwrGit");
      expect(container.querySelector<HTMLButtonElement>(".clone-dialog__submit")!.disabled).toBe(true);
      expect(container.querySelectorAll(".clone-source-row")).toHaveLength(0);
      expect(dispatchMock.mock.calls.some(([channel]) => channel === "repo:searchCloneSources")).toBe(false);
    }
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks();
  }
});

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
          roots: [], onboardingCompleted: true,
          showInMenu: true
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
          roots: [], onboardingCompleted: true,
          showInMenu: true
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
          roots: [], onboardingCompleted: true,
          showInMenu: true
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
