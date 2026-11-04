import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { repeatedRepoNames } from "./ClonesPanel";

describe("repeated repository names, for any list", () => {
  it("names exactly the names two or more repositories share", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.uuid(), name: fc.constantFrom("atlas", "gpui-kit", "lambda-dispatch", "notes"), path: fc.string(), profileId: fc.constant("p"), profileName: fc.constant("P") }), { maxLength: 10 }),
        (list) => {
          const repeated = repeatedRepoNames(list);
          for (const name of new Set(list.map((repo) => repo.name))) {
            expect(repeated.has(name)).toBe(list.filter((repo) => repo.name === name).length >= 2);
          }
          expect([...repeated].every((name) => list.some((repo) => repo.name === name))).toBe(true);
        }
      )
    );
  });
});
