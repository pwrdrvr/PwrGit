import { describe, expect, expectTypeOf, it } from "vitest";
import { err, ok, type Result } from "./result";
import {
  inferUpdateSelection,
  resolveUpdateSelection,
  type CommandName,
  type Req,
  type Res
} from "./protocol";

describe("Result", () => {
  it("ok carries the value and narrows", () => {
    const r: Result<number> = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it("err carries the typed error and narrows", () => {
    const r: Result<number> = err({
      kind: "git",
      code: "exit_1",
      message: "boom"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("git");
      expect(r.error.code).toBe("exit_1");
    }
  });
});

describe("command registry", () => {
  it("threads typed req/res through a mock dispatch without `any`", async () => {
    // A mock dispatch that echoes a canned response. The point of the test is
    // the type plumbing: Req<C> / Res<C> resolve per command name.
    const table: { ping: string } = { ping: "pong" };
    async function dispatch<C extends CommandName>(
      name: C,
      _req: Req<C>
    ): Promise<Res<C>> {
      return table[name as "ping"] as Res<C>;
    }

    const res = await dispatch("ping", undefined);
    expect(res).toBe("pong");
  });

  it("exposes one typed command for discarding all worktree changes", () => {
    expectTypeOf<Req<"changes:discardAll">>().toEqualTypeOf<{
      worktreeId: string;
    }>();
    expectTypeOf<Res<"changes:discardAll">>().toEqualTypeOf<null>();
  });

  it("guards profile deletion with the current display name", () => {
    expectTypeOf<Req<"profile:delete">>().toEqualTypeOf<{
      profileId: string;
      expectedName: string;
    }>();
    expectTypeOf<Res<"profile:delete">>().toMatchTypeOf<{
      deletedProfileId: string;
      activeProfileId: string;
    }>();
  });
});

describe("inferUpdateSelection", () => {
  it("maps website download versions onto the matching train and track", () => {
    expect(inferUpdateSelection("1.0.1")).toEqual({
      train: "stable",
      channel: "latest"
    });
    expect(inferUpdateSelection("1.0.1-prerelease.5")).toEqual({
      train: "stable",
      channel: "prerelease"
    });
    expect(inferUpdateSelection("1.1.0-beta.2")).toEqual({
      train: "beta",
      channel: "latest"
    });
    expect(inferUpdateSelection("v1.1.0-alpha.7")).toEqual({
      train: "beta",
      channel: "prerelease"
    });
  });

  it("keeps historical 1.0.0-beta builds on Stable Latest", () => {
    expect(inferUpdateSelection("1.0.0-beta.50")).toEqual({
      train: "stable",
      channel: "latest"
    });
  });
});

describe("resolveUpdateSelection", () => {
  it("infers from the app version only when both keys are absent", () => {
    expect(resolveUpdateSelection(undefined, "1.1.0-beta.2")).toEqual({
      train: "beta",
      channel: "latest"
    });
    expect(resolveUpdateSelection({}, "1.1.0-alpha.7")).toEqual({
      train: "beta",
      channel: "prerelease"
    });
  });

  it("keeps a legacy channel-only prerelease config on the Stable train", () => {
    expect(
      resolveUpdateSelection({ channel: "prerelease" }, "1.1.0-beta.2")
    ).toEqual({
      train: "stable",
      channel: "prerelease"
    });
  });

  it("honors an explicit Stable Latest choice on a Beta binary", () => {
    expect(
      resolveUpdateSelection(
        { train: "stable", channel: "latest" },
        "1.1.0-beta.2"
      )
    ).toEqual({
      train: "stable",
      channel: "latest"
    });
  });
});
