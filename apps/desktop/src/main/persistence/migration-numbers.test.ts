import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "migrations");

// The runner applies files in name order and records them by full name, so two
// files sharing a number both run, ordered only by the rest of their names. A
// branch that rebases onto a main that took its number must take the next free
// one instead (as 0047_remote_tag_snapshots did when main shipped 0045).
it("gives every migration its own number", () => {
  const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql"));
  const byNumber = new Map<string, string[]>();
  for (const file of files) {
    const number = /^(\d{4})_/.exec(file)?.[1];
    expect(number, `${file} has no four-digit number`).toBeDefined();
    byNumber.set(number!, [...(byNumber.get(number!) ?? []), file]);
  }
  const shared = [...byNumber.values()].filter((names) => names.length > 1);
  expect(shared).toEqual([]);
});
