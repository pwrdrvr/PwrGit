import { describe, expect, it } from "vitest";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "./profile-service";

function service(): ProfileService {
  return new ProfileService(openDatabase(":memory:"));
}

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
});
