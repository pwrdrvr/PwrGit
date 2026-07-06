import { describe, expect, it } from "vitest";
import { err, ok } from "@pwrgit/shared";
import { CommandBus } from "./command-bus";

describe("CommandBus", () => {
  it("returns the ok value from a registered handler", async () => {
    const bus = new CommandBus();
    bus.register("ping", () => ok("pong"));
    const res = await bus.dispatch("ping", undefined);
    expect(res).toEqual({ ok: true, value: "pong" });
  });

  it("propagates a handler's err Result without throwing", async () => {
    const bus = new CommandBus();
    bus.register("ping", () =>
      err({ kind: "unknown", code: "nope", message: "declined" })
    );
    const res = await bus.dispatch("ping", undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("nope");
  });

  it("returns a typed error for an unregistered command", async () => {
    const bus = new CommandBus();
    const res = await bus.dispatch("ping", undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("no_handler");
  });

  it("catches a thrown handler and returns an err Result", async () => {
    const bus = new CommandBus();
    bus.register("ping", () => {
      throw new Error("kaboom");
    });
    const res = await bus.dispatch("ping", undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("handler_threw");
      expect(res.error.message).toContain("kaboom");
    }
  });
});
