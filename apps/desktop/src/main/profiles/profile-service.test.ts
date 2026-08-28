import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "./profile-service";

const databases: DB[] = [];

function service(): ProfileService {
  const db = openDatabase(":memory:");
  databases.push(db);
  return new ProfileService(db);
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("ProfileService", () => {
  it("ensureSeed creates exactly one default profile and is idempotent", () => {
    const s = service();
    const seed = {
      name: "Default",
      email: "me@example.com",
      mono: "",
      kind: "Personal",
      roots: []
    };
    s.ensureSeed(seed);
    s.ensureSeed(seed);
    expect(s.list()).toHaveLength(1);
    expect(s.getActiveId()).not.toBeNull();
  });

  it("derives a slug id and mono and persists email + roots", () => {
    const s = service();
    const p = s.create({ name: "Acme Cloud", email: "n@acme.io", roots: ["/x"] });
    expect(p.id).toBe("acme-cloud");
    expect(p.mono).toBe("A");
    expect(p.email).toBe("n@acme.io");
    expect(p.roots).toEqual(["/x"]);
  });

  it("uniquifies slug ids across duplicate names", () => {
    const s = service();
    const a = s.create({ name: "Work", email: "a@x.com" });
    const b = s.create({ name: "Work", email: "b@x.com" });
    expect(a.id).toBe("work");
    expect(b.id).toBe("work-2");
  });

  it("makes the first profile active; switch changes active and records last-used", () => {
    const s = service();
    const a = s.create({ name: "A", email: "a@x.com" });
    const b = s.create({ name: "B", email: "b@x.com" });
    expect(s.getActiveId()).toBe(a.id);

    const snap = s.switch(b.id);
    expect(snap.activeProfileId).toBe(b.id);
    expect(s.get(b.id)?.lastUsedAt).toBeTruthy();
  });

  it("keeps per-profile commit email distinct and does not bleed across profiles", () => {
    const s = service();
    const a = s.create({ name: "A", email: "a@x.com" });
    const b = s.create({ name: "B", email: "b@x.com" });
    expect(s.get(a.id)?.email).toBe("a@x.com");
    expect(s.get(b.id)?.email).toBe("b@x.com");
  });

  it("persists a fixed theme and clears it back to app inheritance", () => {
    const s = service();
    const profile = s.create({
      name: "Light workspace",
      email: "light@example.com",
      theme: "light"
    });
    expect(profile.theme).toBe("light");

    expect(s.update({ profileId: profile.id, theme: "dark" })?.theme).toBe(
      "dark"
    );
    expect(s.update({ profileId: profile.id, theme: null })?.theme).toBeUndefined();
  });

  it("keeps existing profiles on app theme inheritance", () => {
    const s = service();
    const profile = s.create({ name: "Inherited", email: "i@example.com" });
    expect(profile.theme).toBeUndefined();
  });

  it("requires an exact current name and protects the final profile", () => {
    const s = service();
    const only = s.create({ name: "Personal", email: "me@example.com" });

    const mismatched = s.delete({
      profileId: only.id,
      expectedName: "personal"
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error.code).toBe("confirmation_mismatch");

    const final = s.delete({ profileId: only.id, expectedName: only.name });
    expect(final.ok).toBe(false);
    if (!final.ok) expect(final.error.code).toBe("last_profile");
    expect(s.snapshot()).toEqual({
      activeProfileId: only.id,
      profiles: [only]
    });
  });

  it("chooses the next ordered profile, or the previous one at the end", () => {
    const s = service();
    const a = s.create({ name: "A", email: "a@example.com" });
    const b = s.create({ name: "B", email: "b@example.com" });
    const c = s.create({ name: "C", email: "c@example.com" });

    s.switch(b.id);
    const middle = s.delete({ profileId: b.id, expectedName: b.name });
    expect(middle.ok).toBe(true);
    if (!middle.ok) return;
    expect(middle.value.activeProfileId).toBe(c.id);

    s.switch(c.id);
    const end = s.delete({ profileId: c.id, expectedName: c.name });
    expect(end.ok).toBe(true);
    if (!end.ok) return;
    expect(end.value.activeProfileId).toBe(a.id);
  });

  it("repairs a missing active-profile selection without reseeding", () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const s = new ProfileService(db);
    const profile = s.create({ name: "Existing", email: "x@example.com" });
    db.prepare("DELETE FROM app_meta WHERE key = 'active_profile_id'").run();

    s.ensureSeed({ name: "Default", email: "default@example.com" });

    expect(s.list()).toHaveLength(1);
    expect(s.getActiveId()).toBe(profile.id);
  });
});
