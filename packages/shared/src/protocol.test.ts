import { describe, expect, expectTypeOf, it } from "vitest";
import { err, ok, type Result } from "./result";
import {
  inferUpdateSelection,
  resolveUpdateSelection,
  type CommandName,
  type Req,
  type Res,
  type UpdateChannel,
  type UpdateSelectionSource
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

  it("keeps partial index operations typed and snapshot-bound", () => {
    expectTypeOf<Req<"changes:applySelection">>().toEqualTypeOf<{
      worktreeId: string;
      path: string;
      staged: boolean;
      fingerprint: string;
      lineIds: string[];
    }>();
    expectTypeOf<Res<"diff:fileSelection">>().toHaveProperty("fingerprint");
    expectTypeOf<Res<"diff:fileSelection">>().toHaveProperty("hunks");
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
  it("infers from the app version while nothing is pinned", () => {
    expect(resolveUpdateSelection(undefined, "1.1.0-beta.2")).toEqual({
      train: "beta",
      channel: "latest",
      selectionSource: "inferred"
    });
    expect(resolveUpdateSelection({}, "1.1.0-alpha.7")).toEqual({
      train: "beta",
      channel: "prerelease",
      selectionSource: "inferred"
    });
  });

  // The bug this replaced: a stored pair with no `selectionSource` read as a
  // deliberate pin, so an alpha install was offered the last stable forever
  // and never told about the newer alpha it came from. A half pair proves
  // nothing about intent, so the binary decides.
  it("re-infers a half-written legacy config from the running binary", () => {
    expect(
      resolveUpdateSelection({ channel: "prerelease" }, "1.1.0-beta.2")
    ).toEqual({
      train: "beta",
      channel: "latest",
      selectionSource: "inferred"
    });
  });

  // Stable/Latest is what the old write path stamped on ANY click, including
  // a click on the segment already selected — it cannot be told apart from
  // "never chose", so the installed binary wins until somebody pins.
  it("re-infers a legacy Stable Latest pair onto the alpha feed it runs", () => {
    expect(
      resolveUpdateSelection(
        { train: "stable", channel: "latest" },
        "1.1.0-alpha.7"
      )
    ).toEqual({
      train: "beta",
      channel: "prerelease",
      selectionSource: "inferred"
    });
  });

  // Any non-default legacy pair could only have come from a real click.
  it("treats a legacy non-default pair as an existing pin", () => {
    expect(
      resolveUpdateSelection({ train: "beta", channel: "latest" }, "1.0.3")
    ).toEqual({
      train: "beta",
      channel: "latest",
      selectionSource: "user"
    });
  });

  it("honors an explicit Stable Latest pin on a Beta binary", () => {
    expect(
      resolveUpdateSelection(
        { train: "stable", channel: "latest", selectionSource: "user" },
        "1.1.0-beta.2"
      )
    ).toEqual({
      train: "stable",
      channel: "latest",
      selectionSource: "user"
    });
  });

  // A pin whose file lost one axis (a truncated write, a hand edit with a
  // typo) keeps the axis that survived AND stays pinned — re-inferring the
  // pair would quietly move a deliberate Stable pin onto the alpha feed.
  it("keeps a pin whose stored pair lost one axis", () => {
    expect(
      resolveUpdateSelection(
        { train: "stable", channel: "lates" as UpdateChannel, selectionSource: "user" },
        "1.1.0-alpha.7"
      )
    ).toEqual({
      train: "stable",
      channel: "latest",
      selectionSource: "user"
    });
  });

  it("ignores a selectionSource that is not one of the two states", () => {
    expect(
      resolveUpdateSelection(
        {
          train: "beta",
          channel: "latest",
          selectionSource: "pinned" as UpdateSelectionSource
        },
        "1.0.3"
      )
    ).toEqual({
      train: "beta",
      channel: "latest",
      // Falls through to the legacy classification: a non-default pair.
      selectionSource: "user"
    });
  });
});
