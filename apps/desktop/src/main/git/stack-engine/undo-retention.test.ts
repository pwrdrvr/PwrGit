import { expect, test } from "vitest";
import { StackGit } from "./git";
import { expireStackUndo } from "./undo-retention";
import { git, runner, withRepo } from "./fixture.test-support";

test("Git retains the newest fifty undo operations for up to fourteen days", () => withRepo(async (cwd, tip) => {
  const local = new StackGit(runner, cwd);
  const now = 30 * 24 * 60 * 60 * 1000;
  const commands = ["start"];
  for (let index = 0; index < 52; index += 1) {
    const id = `retention-${index}`;
    const ref = `refs/pwrgit/undo/${id}`;
    const when = index < 51 ? now - 100 + index : 0;
    const oid = (await local.output(["hash-object", "-w", "--stdin"], JSON.stringify({ when, id }))).trim();
    commands.push(`create ${ref}/receipt ${oid}`, `create ${ref}/heads/layer ${tip}`);
  }
  await local.output(["update-ref", "--stdin"], [...commands, "prepare", "commit", ""].join("\n"));
  await expireStackUndo(local, now);
  const kept = (await git(cwd, "for-each-ref", "--format=%(refname)", "refs/pwrgit/undo/")).split("\n");
  expect(kept).toHaveLength(100);
  expect(kept).not.toContain("refs/pwrgit/undo/retention-0/receipt");
  expect(kept).not.toContain("refs/pwrgit/undo/retention-51/receipt");
  expect(kept).toContain("refs/pwrgit/undo/retention-50/heads/layer");
}));
