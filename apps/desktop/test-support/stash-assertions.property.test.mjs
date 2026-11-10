import fc from "fast-check";
import { expect, it } from "vitest";
import { expectEmptyStash } from "../e2e/fixtures/stash-assertions.ts";

// Oracle: after Restore, stash reads may still see the old entry or race the
// removal of refs/stash. Only a successful empty read proves completion.
it("retries every transient read until Git confirms the stash is empty", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.boolean(), { minLength: 1, maxLength: 2 }),
    async (failures) => {
      let reads = 0;
      await expectEmptyStash(() => {
        const index = reads++;
        if (index === failures.length) return "";
        if (failures[index]) throw new Error("fatal: bad revision 'refs/stash'");
        return "stash@{0}: On main: pwrgit: left on main";
      }, 5_000);
      expect(reads).toBe(failures.length + 1);
    },
  ), { numRuns: 10 });
});

it("survives refs/stash disappearing during the first stash-list read", async () => {
  let reads = 0;
  await expectEmptyStash(() => {
    if (++reads === 1) throw new Error("fatal: bad revision 'refs/stash'");
    return "";
  }, 5_000);
  expect(reads).toBe(2);
});

it("still fails when Git never confirms an empty stash", async () => {
  await expect(expectEmptyStash(() => {
    throw new Error("fatal: bad revision 'refs/stash'");
  }, 150)).rejects.toThrow("bad revision");
  await expect(expectEmptyStash(() => "stash@{0}: saved work", 150)).rejects.toThrow("saved work");
});
