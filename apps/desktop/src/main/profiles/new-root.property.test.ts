import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { err, ok, type NewRootChoice, type Result } from "@pwrgit/shared";
import { openDatabase } from "../persistence/db";
import { NewRootService, runInNewRoot } from "./new-root";
import { ProfileService } from "./profile-service";

// The rules for a folder Clone, Fork or the wizard may create (card 5a, 3b):
//
// - Main creates or registers a folder only by a suggested name under home,
//   or a path the system folder picker returned. Any other path a renderer
//   sends is refused, and nothing on disk or in the profile changes.
// - The folder is created and added only when the operation starts, and a
//   failed or cancelled operation leaves the disk and the profile exactly as
//   they were before it.

const scratch = mkdtempSync(join(tmpdir(), "pwrgit-new-root-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let run = 0;

function setup() {
  run += 1;
  const home = realpathSync(mkdtempSync(join(scratch, `home-${run}-`)));
  const db = openDatabase(":memory:");
  const profiles = new ProfileService(db);
  const profile = profiles.create({ name: "Personal", email: "p@example.com", roots: [] });
  const other = profiles.create({ name: "Work", email: "w@example.com", roots: [join(home, "work")] });
  const service = new NewRootService(profiles, () => home, process.platform);
  const snapshot = () => ({
    roots: profiles.get(profile.id)!.roots,
    entries: readdirSync(home).sort()
  });
  return { home, db, profiles, profile, other, service, snapshot };
}

const choiceArb = fc.oneof(
  fc.record({ kind: fc.constant("suggested" as const), name: fc.constantFrom("projects", "github", "git") }),
  fc.record({
    kind: fc.constant("picked" as const),
    name: fc.constantFrom("picked-a", "elsewhere", "work", "work/inner"),
    remembered: fc.boolean()
  }),
  // A renderer naming something it was never offered.
  fc.record({ kind: fc.constant("forged" as const), name: fc.constantFrom("../escape", "Library", "projects/../x") })
);

describe("new repository folders", () => {
  it("creates or adds only what it may, and a failed operation leaves nothing behind", async () => {
    await fc.assert(
      fc.asyncProperty(
        choiceArb,
        fc.boolean(),
        fc.constantFrom("ok", "fail", "throw"),
        async (pick, exists, outcome) => {
          const { home, db, profile, service, snapshot } = setup();
          try {
            const folder = join(home, pick.name);
            if (exists && pick.kind !== "forged") mkdirSync(folder, { recursive: true });
            let choice: NewRootChoice;
            if (pick.kind === "suggested") choice = { kind: "suggested", name: pick.name };
            else if (pick.kind === "picked") {
              if (pick.remembered && exists) service.rememberPicked([folder]);
              choice = { kind: "picked", path: folder };
            } else {
              choice = { kind: "suggested", name: pick.name as "projects" };
            }
            const before = snapshot();
            let ran: string | null = null;
            const operation = async (parentPath: string): Promise<Result<string>> => {
              ran = parentPath;
              if (outcome === "fail") return err({ kind: "git", code: "clone_failed", message: "no" });
              if (outcome === "throw") throw new Error("boom");
              return ok(parentPath);
            };
            const result = await runInNewRoot(service, profile.id, choice, "", operation, {
              rootsChanged: () => undefined,
              scanExisting: () => undefined
            }).catch(() => null);

            const allowed =
              pick.kind === "suggested" ||
              (pick.kind === "picked" && pick.remembered && exists && !pick.name.startsWith("work"));
            if (!allowed) {
              // Refused before anything ran or changed.
              expect(ran).toBeNull();
              expect(snapshot()).toEqual(before);
              return;
            }
            expect(ran).toBe(folder);
            if (outcome === "ok") {
              expect(result).toEqual(ok(folder));
              expect(existsSync(folder)).toBe(true);
              expect(snapshot().roots).toEqual([...before.roots, folder]);
            } else {
              expect(snapshot()).toEqual(before);
            }
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 120 }
    );
  });

  it("lists the suggested folders under home, and which exist", async () => {
    const { home, db, service } = setup();
    mkdirSync(join(home, "github"));
    expect((await service.suggested()).map((s) => [s.name, s.path, s.exists])).toEqual([
      ["projects", join(home, "projects"), false],
      ["github", join(home, "github"), true],
      ["git", join(home, "git"), false]
    ]);
    db.close();
  });
});
