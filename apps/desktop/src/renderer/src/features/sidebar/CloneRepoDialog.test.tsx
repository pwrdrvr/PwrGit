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
        roots: [], onboardingCompleted: true,
        showInMenu: true
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

it("keeps an explicit fork pick when the forge then refuses it, rather than cloning the original", async () => {
  mockForge(preflight());
  let answer!: (value: unknown) => void;
  dispatchMock.mockImplementation(((base) => (channel: string, ...rest: unknown[]) => {
    if (channel === "repo:forkPreflight") {
      return new Promise((resolve) => { answer = resolve; });
    }
    return base(channel, ...rest);
  })(dispatchMock.getMockImplementation()!));
  await openAndPick();

  await act(async () => card("Your fork").click());
  const refused: ForkPreflight = {
    ...preflight(),
    blocked: {
      code: "forking_disabled",
      message: "riverbend/sparkline already exists and is not a fork of octo-labs/sparkline."
    }
  };
  await act(async () => answer(ok(refused)));

  expect(card("Your fork").getAttribute("aria-pressed")).toBe("true");
  expect(card("Your fork").textContent).toContain("already exists and is not a fork");
  expect(submit().textContent).not.toBe("Clone repository");
  expect(submit().disabled).toBe(true);
});

it("offers no pair when the account lookup fails", async () => {
  mockForge(preflight());
  dispatchMock.mockImplementation(((base) => (channel: string, ...rest: unknown[]) => {
    if (channel === "repo:forkTargets") {
      return Promise.resolve({ ok: false, error: { kind: "remote", code: "x", message: "gh: not logged in" } });
    }
    return base(channel, ...rest);
  })(dispatchMock.getMockImplementation()!));
  await openAndPick();

  expect(container.querySelector(".clone-from")).toBeNull();
  expect(submit().textContent).toBe("Clone repository");
});

// ── Upstream when the picked repository is itself a fork ────────────────────
// design/Upstream When Cloning a Fork - UX Review.dc.html, 2a and 3.

const parentRef = { nameWithOwner: "octo-labs/sparkline", url: "https://github.com/octo-labs/sparkline" };
const yourFork: CloneRepository = { ...fork, parent: parentRef };

/** The forge as `mockForge` answers it, except for what the exact-name check
 *  says the picked repository is, and which accounts a fork could land in. */
function mockPick(
  picked: (call: number) => CloneRepository,
  targets = [
    { login: "riverbend", kind: "user", host: "github" },
    { login: "lumen-co", kind: "organization", host: "github" }
  ]
): void {
  mockForge(preflight());
  let checks = 0;
  dispatchMock.mockImplementation(((base) => (channel: string, ...rest: unknown[]) => {
    if (channel === "repo:checkCloneSource") return Promise.resolve(ok(picked(checks++)));
    if (channel === "repo:forkTargets") return Promise.resolve(ok(targets));
    return base(channel, ...rest);
  })(dispatchMock.getMockImplementation()!));
}

const upstreamOption = (): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>(".fork-option input[type=checkbox]");
const willCreate = (): string =>
  container.querySelector("#clone-destination-choice")?.textContent ?? "";

it("keeps your fork's parent as upstream unless you opt out", async () => {
  mockPick(() => yourFork);
  await openAndPick();

  // Your own fork: no Clone from pair, just the option row.
  expect(container.querySelector(".clone-from")).toBeNull();
  expect(upstreamOption()?.checked).toBe(true);
  expect(container.querySelector(".fork-option")?.textContent).toContain(
    "Add upstream → octo-labs/sparkline"
  );
  expect(willCreate()).toContain("upstream octo-labs/sparkline");

  await act(async () => submit().click());
  expect(dispatchMock).toHaveBeenCalledWith("repo:clone", expect.objectContaining({
    nameWithOwner: "riverbend/sparkline",
    upstream: "octo-labs/sparkline"
  }));
});

it("sends no upstream once the option is cleared", async () => {
  mockPick(() => yourFork);
  await openAndPick();

  await act(async () => upstreamOption()!.click());
  expect(willCreate()).not.toContain("upstream");

  await act(async () => submit().click());
  const request = dispatchMock.mock.calls.find(([channel]) => channel === "repo:clone")?.[1];
  expect(request).toMatchObject({ nameWithOwner: "riverbend/sparkline" });
  expect(request).not.toHaveProperty("upstream");
});

it("asks which repository upstream is for a fork of a fork, the parent first", async () => {
  mockPick(() => ({
    ...fork,
    parent: { nameWithOwner: "lumen-co/sparkline", url: "https://github.com/lumen-co/sparkline" },
    root: parentRef
  }));
  await openAndPick();

  const radios = [...container.querySelectorAll<HTMLInputElement>("input[name=clone-upstream]")];
  expect(radios.map((radio) => radio.closest("label")?.querySelector("strong")?.textContent)).toEqual([
    "lumen-co/sparkline",
    "octo-labs/sparkline"
  ]);
  expect(radios[0]?.checked).toBe(true);
  expect(willCreate()).toContain("upstream lumen-co/sparkline");

  await act(async () => radios[1]!.click());
  expect(willCreate()).toContain("upstream octo-labs/sparkline");
  await act(async () => submit().click());
  expect(dispatchMock).toHaveBeenCalledWith("repo:clone", expect.objectContaining({
    upstream: "octo-labs/sparkline"
  }));
});

it("reads the lineage once more for a search row, and waits for it before cloning", async () => {
  // A search row carries no parent, and with no other account to fork into
  // there is no preflight to supply one. The exact-name check is refused
  // here, so the row picked is the search row.
  mockForge(preflight());
  let lookup!: (value: unknown) => void;
  let checks = 0;
  dispatchMock.mockImplementation(((base) => (channel: string, ...rest: unknown[]) => {
    if (channel === "repo:checkCloneSource") {
      return checks++ === 0
        ? Promise.resolve({ ok: false, error: { kind: "remote", code: "repository_not_found", message: "not found" } })
        : new Promise((resolve) => { lookup = resolve; });
    }
    if (channel === "repo:searchCloneSources") return Promise.resolve(ok([fork]));
    if (channel === "repo:forkTargets") {
      return Promise.resolve(ok([{ login: "riverbend", kind: "user", host: "github" }]));
    }
    return base(channel, ...rest);
  })(dispatchMock.getMockImplementation()!));
  await openAndPick();

  // Not known yet: Clone waits rather than sending no upstream.
  expect(checks).toBe(2);
  expect(upstreamOption()).toBeNull();
  expect(submit().disabled).toBe(true);
  await act(async () => submit().click());
  expect(dispatchMock.mock.calls.some(([channel]) => channel === "repo:clone")).toBe(false);

  await act(async () => lookup(ok(yourFork)));
  expect(dispatchMock.mock.calls.some(([channel]) => channel === "repo:forkPreflight")).toBe(false);
  expect(upstreamOption()?.checked).toBe(true);
  expect(submit().disabled).toBe(false);
  await act(async () => submit().click());
  expect(dispatchMock).toHaveBeenCalledWith("repo:clone", expect.objectContaining({
    upstream: "octo-labs/sparkline"
  }));
});

it("takes the exact-name check as the answer, and asks nothing more", async () => {
  mockPick(() => ({ ...fork }), [{ login: "riverbend", kind: "user", host: "github" }]);
  await openAndPick();

  expect(
    dispatchMock.mock.calls.filter(([channel]) => channel === "repo:checkCloneSource")
  ).toHaveLength(1);
  expect(upstreamOption()).toBeNull();
  expect(submit().disabled).toBe(false);
});

it("shows the checkout instead of retrying when only the upstream remote failed", async () => {
  mockPick(() => yourFork);
  const cloned = {
    id: "r1", name: "sparkline", path: "/src/github/sparkline", profileId: "p",
    pinned: false, worktrees: [],
    upstreamFailure: "Cloned to /src/github/sparkline, but couldn't add octo-labs/sparkline as a remote: locked. Add it from Refs → Remotes."
  };
  dispatchMock.mockImplementation(((base) => (channel: string, ...rest: unknown[]) =>
    channel === "repo:clone" ? Promise.resolve(ok(cloned)) : base(channel, ...rest)
  )(dispatchMock.getMockImplementation()!));
  const onCloned = vi.fn();
  await act(async () => root.render(
    <CloneRepoDialog
      profile={{
        id: "p", name: "Test", email: "test@example.com", mono: "T",
        roots: [], onboardingCompleted: true, showInMenu: true
      }}
      onCloned={onCloned}
      onReveal={() => undefined}
      onClose={() => undefined}
    />
  ));
  const input = container.querySelector<HTMLInputElement>("#clone-source")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
      .set!.call(input, "riverbend/sparkline");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".clone-source-row")!.click();
  });

  await act(async () => submit().click());
  expect(onCloned).not.toHaveBeenCalled();
  expect(container.querySelector(".clone-submit-error")?.textContent).toContain(
    "couldn't add octo-labs/sparkline as a remote"
  );
  expect(submit().textContent).toBe("Show repository");
  expect(submit().disabled).toBe(false);

  await act(async () => submit().click());
  expect(onCloned).toHaveBeenCalledWith(cloned);
  expect(dispatchMock.mock.calls.filter(([channel]) => channel === "repo:clone")).toHaveLength(1);
});

it("offers no upstream for a repository that is not a fork", async () => {
  mockPick(() => ({ ...fork, owner: "riverbend" }));
  await openAndPick();

  expect(upstreamOption()).toBeNull();
  expect(willCreate()).not.toContain("upstream");
});
