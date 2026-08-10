import { describe, expect, expectTypeOf, it } from "vitest";
import { err, ok, type Result } from "./result";
import type { CommandName, Req, Res } from "./protocol";

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
});
