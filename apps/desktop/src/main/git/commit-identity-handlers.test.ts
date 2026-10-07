import { describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import type { GitExec } from "./dugite";
import { registerCommitIdentityHandlers } from "./commit-identity-handlers";

/** Answers `git var` as a machine with no identity at all: every probe
 *  refuses, so the notice has something to report. */
function gitWith(configured: () => boolean): GitExec {
  return vi.fn(async (args: string[]) => {
    if (args.includes("var")) {
      return configured()
        ? ok({ stdout: "Rowan Vale <rowan@vale.example> 1 +0000\n", stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "fatal: no email was given and auto-detection is disabled\n", exitCode: 128 });
    }
    return ok({ stdout: "", stderr: "", exitCode: 1 });
  }) as unknown as GitExec;
}

function setup(options: { reminder?: boolean; configured?: boolean } = {}) {
  const bus = new CommandBus();
  const state = { configured: options.configured ?? false, alive: new Set([1, 2]) };
  const emitChanged = vi.fn();
  registerCommitIdentityHandlers(bus, {} as DB, {
    git: gitWith(() => state.configured),
    reminderEnabled: () => options.reminder ?? true,
    windowAlive: (id) => state.alive.has(id),
    emitChanged
  });
  const ask = async (webContentsId: number, claimNotice = true) => {
    const result = await bus.dispatch("identity:machine", { claimNotice }, { webContentsId });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  return { bus, state, ask, emitChanged };
}

describe("identity launch notice", () => {
  it("goes to one window, and moves on only when that window is gone", async () => {
    const { ask, state } = setup();
    expect((await ask(1)).notice).toBe(true);
    expect((await ask(2)).notice).toBe(false);
    // The owner asking again (a re-probe on focus) keeps it.
    expect((await ask(1)).notice).toBe(true);
    state.alive.delete(1);
    expect((await ask(2)).notice).toBe(true);
  });

  it("stays quiet for the rest of the launch once dismissed", async () => {
    const { bus, ask, emitChanged } = setup();
    expect((await ask(1)).notice).toBe(true);
    await bus.dispatch("identity:dismissNotice", undefined);
    expect(emitChanged).toHaveBeenCalledOnce();
    expect((await ask(1)).notice).toBe(false);
    expect((await ask(2)).notice).toBe(false);
  });

  it("is never offered when switched off, when Git is configured, or to a reader that did not ask", async () => {
    expect((await setup({ reminder: false }).ask(1)).notice).toBe(false);
    expect((await setup({ configured: true }).ask(1)).notice).toBe(false);
    const quiet = setup();
    const settingsRead = await quiet.ask(1, false);
    expect(settingsRead.notice).toBe(false);
    expect(settingsRead.outside.kind).toBe("missing");
    // A read that did not claim it leaves it for the window that will.
    expect((await quiet.ask(2)).notice).toBe(true);
  });

  it("withdraws when Git becomes configured, and can come back", async () => {
    const { ask, state } = setup();
    expect((await ask(1)).notice).toBe(true);
    state.configured = true;
    expect((await ask(1)).notice).toBe(false);
    state.configured = false;
    expect((await ask(2)).notice).toBe(true);
  });
});
