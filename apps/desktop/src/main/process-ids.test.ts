import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatProcessIds, watchProcessIds, type ProcessIdSample } from "./process-ids";

type AppEventHandler = (...args: unknown[]) => void;

const logMainMock = vi.fn();

// A stand-in Electron `app`: scripted process metrics, plus the event handlers
// watchProcessIds registers so a test can fire them.
const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    handlers,
    app: {
      metrics: [] as unknown[],
      getAppMetrics(): unknown[] {
        return this.metrics;
      },
      on(event: string, handler: (...args: unknown[]) => void): void {
        handlers.set(event, handler);
      }
    }
  };
});

vi.mock("electron", () => ({ app: electron.app }));

vi.mock("./logs", () => ({
  logMain: (...args: unknown[]) => logMainMock(...args)
}));

function metrics(...samples: ProcessIdSample[]): void {
  electron.app.metrics = samples;
}

function fire(event: string, ...args: unknown[]): void {
  electron.handlers.get(event)?.(...args);
}

/** The message argument of every logMain call, in order. */
function loggedLines(): string[] {
  return logMainMock.mock.calls.map((call) => String(call[2]));
}

/** Registers a web-contents-created listener and returns its `once` handlers. */
function createWebContents(): Map<string, AppEventHandler> {
  const registered = new Map<string, AppEventHandler>();
  fire("web-contents-created", {}, {
    once: (event: string, handler: AppEventHandler) => registered.set(event, handler)
  });
  return registered;
}

beforeEach(() => {
  vi.useFakeTimers();
  electron.handlers.clear();
  electron.app.metrics = [];
  logMainMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatProcessIds", () => {
  it("leads with main, GPU and renderer, then names utilities by service", () => {
    expect(
      formatProcessIds([
        {
          pid: 317,
          type: "Utility",
          // `name` is localized; the label has to come from serviceName so two
          // operators' logs spell the same helper the same way.
          name: "Service réseau",
          serviceName: "network.mojom.NetworkService"
        },
        { pid: 330, type: "Tab", name: "PwrGit" },
        { pid: 311, type: "Browser" },
        { pid: 315, type: "GPU" }
      ])
    ).toBe("main=311 gpu=315 renderer=330 utility:NetworkService=317");
  });

  it("labels a helper with no service name by type alone, sorted after the leaders", () => {
    expect(
      formatProcessIds([
        { pid: 351, type: "Utility", serviceName: "audio.mojom.AudioService" },
        { pid: 361, type: "Sandbox helper" },
        { pid: 311, type: "Browser" },
        { pid: 371, type: "Zygote" }
      ])
    ).toBe("main=311 sandbox-helper=361 utility:AudioService=351 zygote=371");
  });

  it("groups same-type processes into one ascending list", () => {
    expect(
      formatProcessIds([
        { pid: 341, type: "Tab", name: "PwrGit — second window" },
        { pid: 330, type: "Tab", name: "PwrGit" }
      ])
    ).toBe("renderer=330,341");
  });

  it("ignores a process Electron reports without a usable pid", () => {
    expect(formatProcessIds([{ pid: 0, type: "Tab" }])).toBe("");
  });
});

describe("watchProcessIds", () => {
  it("logs the table once the helpers have settled", async () => {
    metrics({ pid: 311, type: "Browser" }, { pid: 315, type: "GPU" });
    watchProcessIds();

    expect(loggedLines()).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(loggedLines()).toEqual(["main=311 gpu=315"]);
  });

  it("logs again only when the set of processes actually moved", async () => {
    metrics({ pid: 311, type: "Browser" });
    watchProcessIds();
    await vi.advanceTimersByTimeAsync(500);

    const contents = createWebContents();
    const loaded = (): void => contents.get("did-finish-load")?.();

    // A window whose renderer has no OS process id yet must not rewrite the
    // line — and neither must the page title changing underneath it.
    loaded();
    await vi.advanceTimersByTimeAsync(500);
    expect(loggedLines()).toEqual(["main=311"]);

    metrics({ pid: 311, type: "Browser" }, { pid: 330, type: "Tab", name: "PwrGit" });
    loaded();
    await vi.advanceTimersByTimeAsync(500);

    metrics(
      { pid: 311, type: "Browser" },
      { pid: 330, type: "Tab", name: "PwrGit — repository" }
    );
    loaded();
    await vi.advanceTimersByTimeAsync(500);

    expect(loggedLines()).toEqual(["main=311", "main=311 renderer=330"]);
  });

  it("samples a renderer whose load failed — the process is still there", async () => {
    metrics({ pid: 311, type: "Browser" });
    watchProcessIds();
    await vi.advanceTimersByTimeAsync(500);

    const contents = createWebContents();
    metrics({ pid: 311, type: "Browser" }, { pid: 330, type: "Tab" });
    contents.get("did-fail-load")?.();
    await vi.advanceTimersByTimeAsync(500);

    expect(loggedLines()).toEqual(["main=311", "main=311 renderer=330"]);
  });

  it("collapses a burst of triggers into a single sample", async () => {
    metrics({ pid: 311, type: "Browser" });
    watchProcessIds();
    const contents = createWebContents();
    for (const handler of contents.values()) handler();

    await vi.advanceTimersByTimeAsync(500);
    expect(loggedLines()).toEqual(["main=311"]);
  });

  it("records a dead helper, at warn unless it exited cleanly", async () => {
    metrics({ pid: 311, type: "Browser" }, { pid: 315, type: "GPU" });
    watchProcessIds();
    await vi.advanceTimersByTimeAsync(500);

    metrics({ pid: 311, type: "Browser" });
    fire("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 139 });
    fire("render-process-gone", {}, {}, { reason: "clean-exit", exitCode: 0 });
    await vi.advanceTimersByTimeAsync(500);

    // Each gone line is spelled the way the table spells that process, so one
    // grep finds the crash and the table that replaced it.
    expect(logMainMock.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ["info", "process", "main=311 gpu=315"],
      ["warn", "process", "gpu process gone reason=crashed exitCode=139"],
      ["info", "process", "renderer process gone reason=clean-exit exitCode=0"],
      ["info", "process", "main=311"]
    ]);
  });
});
