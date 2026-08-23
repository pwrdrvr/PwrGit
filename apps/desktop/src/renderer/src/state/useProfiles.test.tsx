// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type ProfileList, type Result } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn(),
  windowProfileId: vi.fn(() => null as string | null)
}));

vi.mock("../lib/pwrgit", () => mocks);

import { useProfiles, type UseProfiles } from "./useProfiles";

const empty: ProfileList = { activeProfileId: null, profiles: [] };
const personal: ProfileList = {
  activeProfileId: "personal",
  profiles: [
    {
      id: "personal",
      name: "Personal",
      email: "me@example.com",
      mono: "P",
      roots: []
    }
  ]
};

let container: HTMLDivElement;
let root: Root;
let latest: UseProfiles;
let pushed: ((value: ProfileList) => void) | undefined;

function Harness() {
  latest = useProfiles();
  return <span>{latest.loadState.status}</span>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  pushed = undefined;
  mocks.subscribe.mockImplementation((_channel: string, listener: typeof pushed) => {
    pushed = listener;
    return vi.fn();
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useProfiles", () => {
  it("exposes a failed read and recovers to a valid empty profile list", async () => {
    mocks.dispatch
      .mockResolvedValueOnce(
        err({ kind: "profile", code: "read_failed", message: "Profile store is busy." })
      )
      .mockResolvedValueOnce(ok(empty));

    await act(async () => root.render(<Harness />));
    expect(latest.loadState).toEqual({
      status: "error",
      message: "Profile store is busy."
    });
    expect(latest.profiles).toEqual([]);

    await act(async () => latest.retry());
    expect(latest.loadState).toEqual({ status: "ready" });
    expect(latest.profiles).toEqual([]);
  });

  it("does not let a stale read replace a newer retry success", async () => {
    const first = deferred<Result<ProfileList>>();
    const second = deferred<Result<ProfileList>>();
    mocks.dispatch
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    act(() => root.render(<Harness />));
    let retry!: Promise<void>;
    act(() => {
      retry = latest.retry();
    });
    await act(async () => {
      second.resolve(ok(personal));
      await retry;
    });
    await act(async () => {
      first.resolve(ok(empty));
      await first.promise;
    });

    expect(latest.loadState).toEqual({ status: "ready" });
    expect(latest.profiles.map((profile) => profile.id)).toEqual(["personal"]);
  });

  it("lets a pushed profile snapshot win over an older boot read", async () => {
    const read = deferred<Result<ProfileList>>();
    mocks.dispatch.mockReturnValue(read.promise);
    act(() => root.render(<Harness />));

    await act(async () => pushed?.(personal));
    await act(async () => {
      read.resolve(ok(empty));
      await read.promise;
    });

    expect(latest.loadState).toEqual({ status: "ready" });
    expect(latest.activeProfile?.id).toBe("personal");
  });
});
