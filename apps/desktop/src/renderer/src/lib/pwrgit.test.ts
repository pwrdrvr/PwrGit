import { afterEach, describe, expect, it } from "vitest";
import { dispatch, dispatchOrThrow, PwrGitDispatchError, subscribe } from "./pwrgit";

type Bridge = Window["pwrgit"];

function installBridge(
  bridge: Partial<Bridge> & Pick<Bridge, "dispatch" | "on">
): void {
  (globalThis as { window?: { pwrgit: Bridge } }).window = {
    pwrgit: {
      profileId: null,
      platform: "darwin",
      getAppMenuModel: async () => [],
      popupAppMenu: () => {},
      ...bridge
    }
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("renderer dispatch helpers", () => {
  it("dispatch returns the Result the bridge produced", async () => {
    installBridge({
      profileId: null,
      dispatch: async () => ({ ok: true, value: "pong" }),
      on: () => () => {}
    });
    const res = await dispatch("ping", undefined);
    expect(res).toEqual({ ok: true, value: "pong" });
  });

  it("dispatchOrThrow unwraps an ok Result", async () => {
    installBridge({
      profileId: null,
      dispatch: async () => ({ ok: true, value: "pong" }),
      on: () => () => {}
    });
    expect(await dispatchOrThrow("ping", undefined)).toBe("pong");
  });

  it("dispatchOrThrow throws PwrGitDispatchError on an err Result", async () => {
    installBridge({
      profileId: null,
      dispatch: async () => ({
        ok: false,
        error: { kind: "unknown", code: "x", message: "m" }
      }),
      on: () => () => {}
    });
    await expect(dispatchOrThrow("ping", undefined)).rejects.toBeInstanceOf(
      PwrGitDispatchError
    );
  });

  it("subscribe registers the channel and returns a working unsubscribe", () => {
    let registeredChannel: string | null = null;
    let unsubscribed = false;
    installBridge({
      profileId: null,
      dispatch: async () => ({ ok: true, value: "" }),
      on: (channel, _handler) => {
        registeredChannel = channel;
        return () => {
          unsubscribed = true;
        };
      }
    });
    const off = subscribe("profile:changed", () => {});
    expect(registeredChannel).toBe("profile:changed");
    off();
    expect(unsubscribed).toBe(true);
  });
});
