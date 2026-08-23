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
    onChanged: vi.fn()
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
    expect(deps.onChanged).toHaveBeenCalledOnce();
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
});
