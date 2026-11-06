// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  err,
  ok,
  type GitRuntimeStatus,
  type ManagedGitBuild,
  type ManagedGitProgress,
  type ManagedGitStatus
} from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  progress: [] as Array<(payload: unknown) => void>
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: (channel: string, handler: (payload: unknown) => void) => {
    if (channel === "gitManaged:progress") mocks.progress.push(handler);
    return () => undefined;
  }
}));

import { GitRuntimeSettings } from "./GitRuntimeSettings";

const BUNDLED = "/fixture/PwrGit.app/Contents/Resources/git/bin/git";
const V5 = "2.56.0-dev-pwrgit.5";
const V6 = "2.56.0-dev-pwrgit.6";

const build = (version: string): ManagedGitBuild => ({
  id: `${version}-97dd200`,
  version,
  sourceRevision: "97dd200ae74c18d4afe94deb03bc79f29b9d774d",
  path: `/fixture/git-runtimes/versions/${version}-97dd200/darwin-universal/bin/git`,
  trust: "signed",
  lfsVersion: "3.7.1",
  installedAt: 1,
  publishedAt: null
});

const RUNTIME: GitRuntimeStatus = {
  active: "bundled",
  path: BUNDLED,
  keychainHelper: null,
  candidates: [
    { path: BUNDLED, source: "bundled", git: "git version 2.56.0-dev-pwrgit.4", lfs: "git-lfs/3.7.1", problem: null, trust: "signed" },
    { path: "/fixture/homebrew/bin/git", source: "homebrew", git: "git version 2.56.0", lfs: "git-lfs/3.8.1", problem: null }
  ]
};

const UPDATE: ManagedGitStatus = {
  supported: true,
  bundledVersion: "2.56.0-dev-pwrgit.4",
  track: "latest",
  tracks: { latest: V5, prerelease: V5 },
  latest: { version: V5, tag: `v${V5}`, publishedAt: "2026-11-07T12:00:00Z", size: 38_900_000 },
  needsAppUpdate: null,
  checkedAt: Date.now() - 120_000,
  checkError: null,
  builds: [],
  selected: null,
  previous: null,
  inUse: false,
  selectedError: null,
  progress: null
};

let container: HTMLDivElement;
let root: Root;
let runtime: GitRuntimeStatus;
let managed: ManagedGitStatus;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.progress.length = 0;
  (window as unknown as { pwrgit: { platform: string } }).pwrgit = { platform: "darwin" };
  runtime = RUNTIME;
  managed = UPDATE;
  mocks.dispatch.mockImplementation(async (channel: string) => {
    if (channel === "git:runtimeStatus" || channel === "git:selectRuntime") return ok(runtime);
    if (channel === "gitManaged:cancel") return ok(null);
    return ok(managed);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(onOpenUpdates?: () => void): Promise<void> {
  await act(async () => {
    root.render(<GitRuntimeSettings {...(onOpenUpdates === undefined ? {} : { onOpenUpdates })} />);
  });
}

const card = (): HTMLElement => container.querySelector<HTMLElement>("section[aria-label='PwrGit’s Git']")!;
const chip = (): string | null | undefined =>
  card().querySelector(".settings-panel__header .settings-card__chip")?.textContent;
const calls = (channel: string): unknown[][] => mocks.dispatch.mock.calls.filter((call) => call[0] === channel);

function button(name: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name
  );
  if (match === undefined) throw new Error(`Button not found: ${name}`);
  return match;
}

async function push(progress: Omit<ManagedGitProgress, "updatedAt">): Promise<void> {
  await act(async () => {
    for (const handler of mocks.progress) handler({ ...progress, updatedAt: Date.now() });
  });
}

describe("PwrGit’s Git", () => {
  it("offers a newer build, checks once per visit, and downloading never switches Git", async () => {
    let finish: (value: unknown) => void = () => undefined;
    mocks.dispatch.mockImplementation(async (channel: string) => {
      if (channel === "gitManaged:install") return new Promise((resolve) => (finish = resolve));
      if (channel === "git:runtimeStatus") return ok(runtime);
      return ok(managed);
    });
    await render();

    expect(chip()).toBe("Update available");
    expect(calls("gitManaged:check")).toEqual([["gitManaged:check", { force: false }]]);
    expect(card().textContent).toContain(V5);
    expect(card().textContent).toContain("38.9 MB");
    expect(card().textContent).toContain("Downloading doesn’t switch Git.");

    await act(async () => button("Download and verify").click());
    expect(calls("gitManaged:install")).toEqual([["gitManaged:install", { version: V5 }]]);

    // Main reports progress; the reader's focus follows to Cancel.
    managed = { ...UPDATE, progress: { phase: "downloading", version: V5, receivedBytes: 16_300_000, totalBytes: 38_900_000, updatedAt: 1 } };
    await push({ phase: "downloading", version: V5, receivedBytes: 16_300_000, totalBytes: 38_900_000, bytesPerSecond: 4_100_000 });
    expect(chip()).toBe("Downloading 41%");
    const bar = card().querySelector("[role='progressbar']")!;
    expect(bar.getAttribute("aria-valuenow")).toBe("41");
    expect(bar.getAttribute("aria-valuetext")).toBe("16.3 of 38.9 MB");
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(card().textContent).toContain("Repositories keep using 2.56.0-dev-pwrgit.4 meanwhile.");
    const live = card().querySelector("[aria-live='polite']")!;
    expect(live.textContent).toBe("Downloading");
    await push({ phase: "downloading", version: V5, receivedBytes: 30_000_000, totalBytes: 38_900_000 });
    expect(live.textContent).toBe("Downloading");
    await push({ phase: "verifying", version: V5 });
    expect(live.textContent).toBe("Checking files and signatures");
    expect(Array.from(card().querySelectorAll(".settings-git-step"), (step) => step.className)).toEqual([
      "settings-git-step is-done",
      "settings-git-step is-done",
      "settings-git-step is-done",
      "settings-git-step is-active",
      "settings-git-step is-waiting"
    ]);

    // Installed: the build is offered, not chosen.
    managed = { ...UPDATE, builds: [build(V5)], progress: { phase: "ready", version: V5, updatedAt: 2 } };
    await push({ phase: "ready", version: V5 });
    await act(async () => finish(ok(managed)));
    expect(chip()).toBe("Ready to use");
    expect(calls("git:selectRuntime")).toEqual([]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(`Use ${V5}`);
  });

  it("uses a downloaded build only when asked, through the one selection command", async () => {
    managed = { ...UPDATE, builds: [build(V5)] };
    await render();

    runtime = { ...RUNTIME, active: "managed", path: build(V5).path };
    managed = { ...UPDATE, builds: [build(V5)], selected: build(V5).id, inUse: true };
    await act(async () => button(`Use ${V5}`).click());

    expect(calls("git:selectRuntime")).toEqual([["git:selectRuntime", { path: null, managed: build(V5).id }]]);
    expect(chip()).toBe("Up to date");
    expect(button(`Use bundled 2.56.0-dev-pwrgit.4`)).toBeDefined();
  });

  it("keeps the build it replaced for rollback, one click away", async () => {
    runtime = { ...RUNTIME, active: "managed", path: build(V6).path };
    managed = {
      ...UPDATE,
      latest: { ...UPDATE.latest!, version: V6, tag: `v${V6}` },
      builds: [build(V6), build(V5)],
      selected: build(V6).id,
      previous: build(V5).id,
      inUse: true
    };
    await render();

    const rows = Array.from(card().querySelectorAll(".settings-ai-install"), (row) => row.textContent);
    expect(rows[0]).toContain("Using");
    expect(rows[1]).toContain("Previous, kept for rollback");
    await act(async () => button(`Use ${V5}`).click());
    expect(calls("git:selectRuntime").at(-1)).toEqual(["git:selectRuntime", { path: null, managed: build(V5).id }]);
    await act(async () => button("Use bundled 2.56.0-dev-pwrgit.4").click());
    expect(calls("git:selectRuntime").at(-1)).toEqual(["git:selectRuntime", { path: null }]);
  });

  it("says what failed, that nothing changed, and puts focus on Try again", async () => {
    mocks.dispatch.mockImplementation(async (channel: string) => {
      if (channel === "git:runtimeStatus") return ok(runtime);
      if (channel === "gitManaged:install") return new Promise(() => undefined);
      return ok(managed);
    });
    await render();
    await act(async () => button("Download and verify").click());
    const error = "libexec/git-core/git-remote-https isn’t signed by PwrDrvr (team T44CNHC4UH). Nothing was installed.";
    managed = { ...UPDATE, progress: { phase: "failed", version: V5, failedPhase: "verifying", error, updatedAt: 3 } };
    await push({ phase: "failed", version: V5, failedPhase: "verifying", error });

    expect(chip()).toBe("Failed");
    expect(card().querySelector("[role='alert']")?.textContent).toBe(`${error} You’re still on 2.56.0-dev-pwrgit.4.`);
    expect(card().querySelector(".settings-git-step.is-failed")?.textContent).toContain("Files and signatures");
    expect(document.activeElement?.textContent).toBe("Try again");
    await act(async () => button("Try again").click());
    expect(calls("gitManaged:install")).toHaveLength(2);
  });

  // Rule: a failure is said once. One main reported as progress is the
  // failed steps' alert; only one refused before it started is the field's.
  it("says an install failure once, and a refusal before it started in the field", async () => {
    const error = "libexec/git-core/git-remote-https isn’t signed by PwrDrvr (team T44CNHC4UH). Nothing was installed.";
    let answer: (value: unknown) => void = () => undefined;
    mocks.dispatch.mockImplementation(async (channel: string) => {
      if (channel === "git:runtimeStatus") return ok(runtime);
      if (channel === "gitManaged:install") return new Promise((resolve) => (answer = resolve));
      return ok(managed);
    });
    await render();
    await act(async () => button("Download and verify").click());
    managed = { ...UPDATE, progress: { phase: "failed", version: V5, failedPhase: "verifying", error, updatedAt: 3 } };
    await push({ phase: "failed", version: V5, failedPhase: "verifying", error });
    await act(async () => answer(err({ kind: "git", code: "managed_install_failed", message: error })));
    expect(card().textContent?.split(error).length).toBe(2);

    // Try again is refused before it starts: nothing was published.
    const refusal = "2.56.0-dev-pwrgit.6 is still installing.";
    await act(async () => button("Try again").click());
    managed = UPDATE;
    await push({ phase: "idle" });
    await act(async () => answer(err({ kind: "git", code: "managed_install_failed", message: refusal })));
    expect(card().textContent).toContain(refusal);
  });

  it("names each track's build, and switching tracks never downloads or switches Git", async () => {
    managed = { ...UPDATE, tracks: { latest: V5, prerelease: V6 } };
    mocks.dispatch.mockImplementation(async (channel: string, req: { track?: string }) => {
      if (channel === "git:runtimeStatus") return ok(runtime);
      if (channel === "gitManaged:setTrack") {
        managed = { ...managed, track: req.track as ManagedGitStatus["track"], latest: { ...UPDATE.latest!, version: V6, tag: `v${V6}` } };
      }
      return ok(managed);
    });
    await render();
    const track = card().querySelector<HTMLElement>("[role='radiogroup'][aria-label='Build track']")!;
    const options = Array.from(track.querySelectorAll("[role='radio']"), (radio) => [radio.textContent, radio.getAttribute("aria-checked")]);
    expect(options).toEqual([[`Latest${V5}`, "true"], [`Prerelease${V6}`, "false"]]);

    await act(async () => Array.from(track.querySelectorAll<HTMLButtonElement>("[role='radio']"))[1]!.click());
    expect(calls("gitManaged:setTrack")).toEqual([["gitManaged:setTrack", { track: "prerelease" }]]);
    expect(card().textContent).toContain(V6);
    expect(calls("gitManaged:install")).toEqual([]);
    expect(calls("git:selectRuntime")).toEqual([]);
  });

  it("on Latest with nothing promoted, says the Prerelease track has a build", async () => {
    managed = { ...UPDATE, latest: null, tracks: { latest: null, prerelease: V5 } };
    await render();
    expect(chip()).toBe("Up to date");
    expect(card().textContent).toContain(`Prerelease offers ${V5}, not yet promoted.`);
    expect(() => button("Download and verify")).toThrow();
  });

  it("doesn't point at a Prerelease build already in use", async () => {
    runtime = { ...RUNTIME, active: "managed", path: build(V5).path };
    managed = { ...UPDATE, latest: null, tracks: { latest: null, prerelease: V5 }, builds: [build(V5)], selected: build(V5).id, inUse: true };
    await render();
    expect(card().textContent).not.toContain("not yet promoted");
  });

  it("holds the track still while a check runs, and says a failed track is unknown", async () => {
    let answer: (value: unknown) => void = () => undefined;
    managed = { ...UPDATE, latest: null, tracks: { latest: null, prerelease: V6 }, checkError: "v2.56.0-dev-pwrgit.5: digest mismatch" };
    mocks.dispatch.mockImplementation(async (channel: string) => {
      if (channel === "git:runtimeStatus") return ok(runtime);
      if (channel === "gitManaged:check") return new Promise((resolve) => (answer = resolve));
      return ok(managed);
    });
    await render();
    const radios = () => Array.from(card().querySelectorAll<HTMLButtonElement>("[role='radiogroup'][aria-label='Build track'] [role='radio']"));
    expect(radios()[0]!.textContent).toBe("LatestUnavailable");
    expect(radios().every((radio) => radio.disabled)).toBe(true);
    await act(async () => answer(ok(managed)));
    expect(radios().every((radio) => !radio.disabled)).toBe(true);
  });

  // Rule: a track offers only builds newer than the one running.
  it("never offers an older promoted build over a newer prerelease build in use", async () => {
    runtime = { ...RUNTIME, active: "managed", path: build(V6).path };
    managed = { ...UPDATE, tracks: { latest: V5, prerelease: V6 }, builds: [build(V6)], selected: build(V6).id, inUse: true };
    await render();
    expect(chip()).toBe("Up to date");
    expect(() => button("Download and verify")).toThrow();
    expect(card().textContent).toContain(`Nothing newer than ${V6}`);
  });

  it("keeps a Git chosen by path, and says so", async () => {
    runtime = { ...RUNTIME, active: "installed", path: "/fixture/homebrew/bin/git" };
    managed = { ...UPDATE, builds: [build(V5)] };
    await render();

    expect(card().textContent).toContain("In use instead");
    expect(card().textContent).toContain("Homebrew · not verified by PwrGit");
    expect(card().textContent).toContain("You chose this Git by path, so PwrGit keeps running it.");
    expect(calls("git:selectRuntime")).toEqual([]);
  });

  it("works from what it knew when GitHub can’t be reached", async () => {
    managed = { ...UPDATE, latest: null, checkError: "getaddrinfo ENOTFOUND api.github.com", builds: [build(V5)] };
    await render();

    expect(chip()).toBe("Couldn’t check");
    expect(card().textContent).toContain("getaddrinfo ENOTFOUND api.github.com");
    expect(card().textContent).toContain("work offline");
    await act(async () => button("Check now").click());
    expect(calls("gitManaged:check").at(-1)).toEqual(["gitManaged:check", { force: true }]);
  });

  it("offers an app update for a build this PwrGit can’t verify, never a download", async () => {
    managed = { ...UPDATE, latest: null, needsAppUpdate: "2.57.0-dev-pwrgit.1" };
    const openUpdates = vi.fn();
    await render(openUpdates);

    expect(card().textContent).toContain("2.57.0-dev-pwrgit.1 is published but needs a newer PwrGit to verify it.");
    expect(() => button("Download and verify")).toThrow();
    await act(async () => button("Settings › Updates").click());
    expect(openUpdates).toHaveBeenCalled();
  });

  it("offers nothing where PwrGit ships no build of its own", async () => {
    (window as unknown as { pwrgit: { platform: string } }).pwrgit = { platform: "win32" };
    managed = { ...UPDATE, supported: false, latest: null };
    await render();

    expect(chip()).toBe("Not offered");
    expect(calls("gitManaged:check")).toEqual([]);
    expect(card().querySelectorAll("button")).toHaveLength(0);
  });

  it("names a downloaded build in Installs and chooses it by id", async () => {
    runtime = {
      ...RUNTIME,
      candidates: [
        ...RUNTIME.candidates,
        { path: build(V5).path, source: "managed", managedId: build(V5).id, trust: "signed", git: `git version ${V5}`, lfs: "git-lfs/3.7.1", problem: null }
      ]
    };
    managed = { ...UPDATE, builds: [build(V5)] };
    await render();

    const installs = container.querySelector("section[aria-label='Installs']")!;
    expect(installs.textContent).toContain(`PwrGit download · Signed by PwrDrvr · ${V5} · LFS 3.7.1`);
    await act(async () => button(`Use ${build(V5).path}`).click());
    expect(calls("git:selectRuntime").at(-1)).toEqual(["git:selectRuntime", { path: null, managed: build(V5).id }]);
  });
});
