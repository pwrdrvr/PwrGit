// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ok, type CloneRepository, type ForkPreflight } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: () => () => undefined
}));
import { CloneRepoDialog } from "./CloneRepoDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const source: CloneRepository = {
  name: "sparkline",
  owner: "octo-labs",
  nameWithOwner: "octo-labs/sparkline",
  visibility: "public",
  host: "github",
  hostname: "github.com",
  viewerCanPush: false,
  sshUrl: "git@github.com:octo-labs/sparkline.git",
  httpsUrl: "https://github.com/octo-labs/sparkline.git",
  localPaths: []
};

const fork: CloneRepository = {
  ...source,
  owner: "riverbend",
  nameWithOwner: "riverbend/sparkline",
  viewerCanPush: true,
  sshUrl: "git@github.com:riverbend/sparkline.git",
  httpsUrl: "https://github.com/riverbend/sparkline.git"
};

function preflight(existing?: CloneRepository): ForkPreflight {
  return {
    source,
    target: { owner: "riverbend", name: "sparkline", nameWithOwner: "riverbend/sparkline" },
    upstreamChoices: [
      { nameWithOwner: "octo-labs/sparkline", url: "https://github.com/octo-labs/sparkline" }
    ],
    ...(existing === undefined ? {} : { existing })
  };
}

function mockForge(answer: ForkPreflight): void {
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
    if (channel === "repo:cloneDestinations") {
      return Promise.resolve(ok([
        { path: "/src/github", root: "/src", relativePath: "github", repoCount: 3 }
      ]));
    }
    if (channel === "repo:checkCloneSource") return Promise.resolve(ok(source));
    if (channel === "repo:forkTargets") {
      return Promise.resolve(ok([
        { login: "riverbend", kind: "user", host: "github" },
        { login: "lumen-co", kind: "organization", host: "github" }
      ]));
    }
    if (channel === "repo:forkPreflight") return Promise.resolve(ok(answer));
    // Submits stay in flight; the request is what is asserted.
    if (channel === "repo:fork" || channel === "repo:clone") return new Promise(() => undefined);
    return Promise.resolve(ok([]));
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // "Will create" joins the path in the platform's own spelling.
  (window as unknown as { pwrgit: { platform: string } }).pwrgit = { platform: "darwin" };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

async function openAndPick(onReveal = vi.fn()): Promise<void> {
  await act(async () => root.render(
    <CloneRepoDialog
      profile={{
        id: "p", name: "Test", email: "test@example.com", mono: "T",
        roots: [], onboardingCompleted: true
      }}
      onCloned={() => undefined}
      onReveal={onReveal}
      onClose={() => undefined}
    />
  ));
  const input = container.querySelector<HTMLInputElement>("#clone-source")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
      .set!.call(input, "octo-labs/sparkline");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The exact-slug check is debounced 300ms.
  await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".clone-source-row")!.click();
  });
}

const submit = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(".clone-dialog__submit")!;
const card = (title: string): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>(".clone-from__card")].find(
    (b) => b.querySelector("strong")?.textContent === title
  )!;

it("defaults to cloning your fork when you can't push and it already exists", async () => {
  mockForge(preflight(fork));
  await openAndPick();

  expect(card("Your fork").getAttribute("aria-pressed")).toBe("true");
  expect(card("Your fork").textContent).toContain("on GitHub");
  expect(card("The original").textContent).toContain("read-only");
  expect(submit().textContent).toBe("Clone your fork");
  // Everything that names the new checkout names the fork.
  expect(container.querySelector(".clone-protocol small")?.textContent).toBe(
    "git@github.com:riverbend/sparkline.git"
  );

  await act(async () => submit().click());
  expect(dispatchMock).toHaveBeenCalledWith("repo:fork", expect.objectContaining({
    source: "octo-labs/sparkline",
    targetOwner: "riverbend",
    targetOwnerKind: "user",
    targetName: "sparkline",
    parentPath: "/src/github",
    upstream: "octo-labs/sparkline",
    defaultBranchOnly: false
  }));
});

it("keeps the original as the default when no fork exists, and forks on request", async () => {
  mockForge(preflight());
  await openAndPick();

  expect(card("The original").getAttribute("aria-pressed")).toBe("true");
  expect(card("Your fork").textContent).toContain("will be created");
  expect(submit().textContent).toBe("Clone repository");
  // The account row belongs to the fork, so it waits for it to be chosen.
  expect(container.querySelector(".clone-from__into")).toBeNull();

  await act(async () => card("Your fork").click());
  expect(submit().textContent).toBe("Fork & clone");
  expect(container.querySelector(".clone-from__into")?.textContent).toContain("lumen-co");

  await act(async () => card("The original").click());
  await act(async () => submit().click());
  expect(dispatchMock).toHaveBeenCalledWith("repo:clone", expect.objectContaining({
    nameWithOwner: "octo-labs/sparkline",
    parentPath: "/src/github"
  }));
  expect(dispatchMock.mock.calls.some(([channel]) => channel === "repo:fork")).toBe(false);
});

it("reveals a fork that is already checked out instead of cloning it again", async () => {
  mockForge(preflight({ ...fork, localPaths: ["/src/github/sparkline"] }));
  const onReveal = vi.fn();
  await openAndPick(onReveal);

  expect(submit().textContent).toBe("Reveal checkout");
  expect(container.querySelector("#clone-destination")).toBeNull();
  await act(async () => submit().click());
  expect(onReveal).toHaveBeenCalledWith("/src/github/sparkline");
});

it("offers no pair for a repository you own", async () => {
  mockForge(preflight());
  dispatchMock.mockImplementation(((base) => (channel: string, ...rest: unknown[]) => {
    if (channel === "repo:checkCloneSource") {
      return Promise.resolve(ok({ ...source, owner: "riverbend", nameWithOwner: "riverbend/sparkline" }));
    }
    return base(channel, ...rest);
  })(dispatchMock.getMockImplementation()!));
  await openAndPick();

  expect(container.querySelector(".clone-from")).toBeNull();
  expect(submit().textContent).toBe("Clone repository");
});
