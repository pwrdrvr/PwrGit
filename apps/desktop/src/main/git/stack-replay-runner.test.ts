import { expect, test } from "vitest";
import { StackEngine } from "./stack-engine";
import { commit, git, gitEnvironment, withStack } from "./stack-engine/fixture.test-support";
import { createStackReplayRunner } from "./stack-replay-runner";
import { createSystemGit } from "./test-support/system-git";

test("the stack replay records the profile committer and preserves the original author", () =>
  withStack(async ({ cwd, commonDir, store }) => {
    await commit(cwd, "trunk.txt", "advance\n");
    await git(cwd, "config", "committer.email", "repo-config@example.invalid");
    const execute = createSystemGit({
      env: { ...gitEnvironment, GIT_COMMITTER_NAME: "Inherited", GIT_COMMITTER_EMAIL: "inherited@example.invalid" },
    });
    const engine = new StackEngine(createStackReplayRunner(execute, {
      email: "profile@example.invalid", name: "Active Profile",
    }), store, cwd, commonDir);
    const plan = await engine.plan({ kind: "restack", root: "bottom" });
    for (const step of plan.steps) {
      expect(await git(cwd, "show", "-s", "--format=%cn <%ce>%n%an <%ae>", step.newTip!))
        .toBe("Active Profile <profile@example.invalid>\nFixture <fixture@example.invalid>");
    }
  })
);
