import { describe, expect, it, vi } from "vitest";
import type { RepoSearchResult } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { openDatabase } from "../persistence/db";
import { NewRootService } from "../profiles/new-root";
import { ProfileService } from "../profiles/profile-service";
import type { RepoIndexer } from "./repo-indexer";
import { registerRepoSearchHandlers } from "./repo-search-handlers";
import type { HomeSearchOptions } from "./repo-search";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));

// Main decides how many home searches run: one per window. A renderer that
// asks again (a double click, an effect that re-fires) supersedes its own
// search; it can never stack walks of the home folder.

function empty(options: HomeSearchOptions, stopped: boolean): RepoSearchResult {
  return {
    home: options.home,
    folders: [],
    foldersOpened: 1,
    stoppedEarly: stopped ? "stopped" : null,
    includedProtected: options.includeProtected,
    protectedSkipped: [],
    refused: [],
    cloudSkipped: [],
    protectedAskFirst: false,
    homeIsRepository: false
  };
}

function harness() {
  const db = openDatabase(":memory:");
  const profiles = new ProfileService(db);
  const profile = profiles.create({ name: "P", email: "p@example.com", roots: [] });
  const live: HomeSearchOptions[] = [];
  // A walk that runs until it is stopped or cancelled.
  const search = vi.fn(
    (options: HomeSearchOptions) =>
      new Promise<RepoSearchResult>((resolve, reject) => {
        live.push(options);
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        options.stop?.addEventListener("abort", () => resolve(empty(options, true)), { once: true });
      })
  );
  const bus = new CommandBus();
  const handlers = registerRepoSearchHandlers(bus, {
    profiles,
    indexer: {} as RepoIndexer,
    newRoots: new NewRootService(profiles, () => "/home/u"),
    home: () => "/home/u",
    search
  });
  const ask = (searchId: string, webContentsId: number) =>
    bus.dispatch(
      "repo:searchHome",
      { searchId, profileId: profile.id, includeProtected: false },
      { webContentsId }
    );
  return { bus, handlers, ask, live, search };
}

describe("home search handlers", () => {
  it("lets a window's second search supersede its first", async () => {
    const { bus, ask, live } = harness();
    const first = ask("a", 1);
    const second = ask("b", 1);
    expect(await first).toMatchObject({ ok: false, error: { code: "superseded" } });
    expect(live[0]!.signal?.aborted).toBe(true);
    expect(live[1]!.signal?.aborted).toBe(false);
    await bus.dispatch("repo:stopSearch", { searchId: "b" });
    expect((await second).ok).toBe(true);
  });

  it("does not let one window's search cancel another's", async () => {
    const { bus, ask, live } = harness();
    const one = ask("a", 1);
    const two = ask("b", 2);
    expect(live[0]!.signal?.aborted).toBe(false);
    await bus.dispatch("repo:stopSearch", { searchId: "a" });
    await bus.dispatch("repo:stopSearch", { searchId: "b" });
    const [r1, r2] = await Promise.all([one, two]);
    expect(r1.ok && r1.value.stoppedEarly).toBe("stopped");
    expect(r2.ok && r2.value.stoppedEarly).toBe("stopped");
  });

  it("answers Stop with what was found, and a closed window cancels its search", async () => {
    const { bus, ask, handlers, live } = harness();
    const stopped = ask("a", 1);
    await bus.dispatch("repo:stopSearch", { searchId: "a" });
    const result = await stopped;
    expect(result.ok && result.value.stoppedEarly).toBe("stopped");

    const closing = ask("b", 1);
    handlers.releaseWebContents(1);
    expect(live[1]!.signal?.aborted).toBe(true);
    expect((await closing).ok).toBe(false);
  });
});
