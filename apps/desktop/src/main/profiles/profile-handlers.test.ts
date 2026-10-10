import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { openDatabase, type DB } from "../persistence/db";
import {
  registerProfileHandlers,
  type ProfileHandlerDeps
} from "./profile-handlers";
import { ProfileService } from "./profile-service";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));

const databases: DB[] = [];

function fixture() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const profiles = new ProfileService(db);
  const first = profiles.create({ name: "First", email: "first@example.com" });
  const second = profiles.create({ name: "Second", email: "second@example.com" });
  const deps = {
    openWindow: vi.fn(() => true),
    consumeReveal: vi.fn(() => null),
    onDeleted: vi.fn(),
    onChanged: vi.fn(),
    onReordered: vi.fn()
  } satisfies ProfileHandlerDeps;
  const bus = new CommandBus();
  registerProfileHandlers(bus, profiles, deps);
  return { bus, deps, first, profiles, second };
}

describe("profile handlers", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("publishes the surviving profile and hands window cleanup to main", async () => {
    const { bus, deps, first, second } = fixture();

    const result = await bus.dispatch("profile:delete", {
      profileId: first.id,
      expectedName: first.name
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      deletedProfileId: first.id,
      activeProfileId: second.id,
      profiles: [second]
    });
    expect(deps.onDeleted).toHaveBeenCalledExactlyOnceWith(first.id, second.id);
    expect(deps.onChanged).toHaveBeenCalledExactlyOnceWith(second);
    expect(emitEvent).toHaveBeenCalledExactlyOnceWith("profile:changed", {
      activeProfileId: second.id,
      profiles: [second]
    });
  });

  it("does not mutate windows or menus when the guard fails", async () => {
    const { bus, deps, first, profiles } = fixture();

    const result = await bus.dispatch("profile:delete", {
      profileId: first.id,
      expectedName: "wrong"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("confirmation_mismatch");
    expect(profiles.get(first.id)).not.toBeNull();
    expect(deps.onDeleted).not.toHaveBeenCalled();
    expect(deps.onChanged).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("reorders profiles, publishes the new order and rebuilds the menu", async () => {
    const { bus, deps, first, second } = fixture();

    const result = await bus.dispatch("profile:reorder", {
      profileIds: [second.id, first.id]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profiles.map((p) => p.id)).toEqual([second.id, first.id]);
    expect(emitEvent).toHaveBeenCalledExactlyOnceWith("profile:changed", result.value);
    expect(deps.onReordered).toHaveBeenCalledOnce();
  });

  it("leaves the order and the menu alone when the order is stale", async () => {
    const { bus, deps, first, profiles, second } = fixture();

    const result = await bus.dispatch("profile:reorder", {
      profileIds: [second.id]
    });

    expect(result.ok).toBe(false);
    expect(profiles.list().map((p) => p.id)).toEqual([first.id, second.id]);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(deps.onReordered).not.toHaveBeenCalled();
  });

  it("refuses a malformed order or menu switch instead of throwing", async () => {
    const { bus, deps, first, profiles, second } = fixture();

    for (const profileIds of [undefined, "abc", [first.id, 7]]) {
      const result = await bus.dispatch("profile:reorder", {
        profileIds
      } as unknown as { profileIds: string[] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("profile_order_invalid");
    }
    const toggled = await bus.dispatch("profile:update", {
      profileId: first.id,
      showInMenu: "false"
    } as unknown as { profileId: string; showInMenu: boolean });
    expect(toggled.ok).toBe(false);
    if (!toggled.ok) expect(toggled.error.code).toBe("show_in_menu_invalid");

    expect(profiles.list().map((p) => [p.id, p.showInMenu])).toEqual([
      [first.id, true],
      [second.id, true]
    ]);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(deps.onReordered).not.toHaveBeenCalled();
  });

  it("refuses a new profile whose folder sits inside another profile's", async () => {
    const { bus, profiles, first } = fixture();
    profiles.setRoots(first.id, ["/home/rowan/Work"]);
    const result = await bus.dispatch("profile:create", {
      name: "OSS",
      email: "oss@example.com",
      roots: ["/home/rowan/Work/oss"]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("root_overlap");
    expect(result.error.message).toContain("/home/rowan/Work/oss is inside /home/rowan/Work, a folder of “First”.");
    expect(profiles.list().map((profile) => profile.name)).not.toContain("OSS");
  });
});
