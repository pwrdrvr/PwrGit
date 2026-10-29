import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  write: vi.fn(async (_items: unknown[]) => undefined),
  readText: vi.fn(async () => ""),
  fromId: vi.fn(),
  fromWebContents: vi.fn(),
  probe: vi.fn(async () => ({ git: "git version 2.51.0", lfs: "git-lfs/3.7.0" }))
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getAppPath: () => "/app",
    getAppMetrics: () => [{ pid: 311, type: "Browser" }],
    getName: () => "PwrGit",
    getVersion: () => "0.45.0"
  },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  clipboard: { write: mocks.write, readText: mocks.readText },
  ClipboardItem: class {
    constructor(readonly items: Record<string, string>) {}
  },
  webContents: { fromId: mocks.fromId }
}));
vi.mock("./app-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-identity")>()),
  readAppIdentity: () => ({
    name: "PwrGit",
    version: "0.45.0",
    release: { train: "stable", channel: "latest" },
    buildType: "packaged",
    platform: { name: "macOS", version: "26.1", arch: "arm64" },
    electronVersion: "44.9.3",
    diagnosticsText: ""
  })
}));
vi.mock("./logs", () => ({
  logMain: vi.fn(),
  currentLogFilePath: () => "/logs/main.log"
}));
vi.mock("./git/dugite", () => ({
  activeGitPath: () => "/git/bin/git",
  bundledKeychainHelper: () => null,
  execGit: vi.fn(),
  installedGitSelection: () => null
}));
vi.mock("./git/runtime-status", () => ({ probeGitRuntime: mocks.probe }));

const {
  copyDiagnosticsFromMenu,
  diagnosticsTargetProfile,
  registerDiagnosticsCopyHandler
} = await import("./diagnostics-copy");
const { CommandBus } = await import("./command-bus");

type Written = { items: Record<string, string> };

function written(call: number): Record<string, string> {
  const [items] = mocks.write.mock.calls[call] as unknown as [Written[]];
  return items[0]!.items;
}

function contents(pid: number) {
  return { isDestroyed: () => false, getOSProcessId: () => pid };
}

const windowsByProfile: Record<string, unknown> = {};

const deps = {
  profileName: (id: string) => ({ p1: "Personal", p2: "Work" })[id] ?? null,
  openProfileIds: () => ["p1", "p2"],
  profileFor: (window: unknown) =>
    (window as { profileId?: string } | null)?.profileId ?? null,
  windowFor: (id: string) =>
    (windowsByProfile[id] ?? null) as Electron.BrowserWindow | null,
  paths: {
    userData: "/data",
    database: "/data/pwrgit.db",
    settings: "/data/settings.json",
    diagnosticsOutput: "/data/diagnostics"
  }
};

const REPOSITORY = {
  name: "atlas",
  path: "/src/atlas",
  worktreePath: "/src/atlas-wt",
  branch: "feat/x"
};

async function recopy(bus: InstanceType<typeof CommandBus>) {
  mocks.fromId.mockReturnValue(contents(330));
  mocks.fromWebContents.mockReturnValue({ profileId: "p1" });
  return bus.dispatch(
    "app:copyDiagnostics",
    { repository: REPOSITORY },
    { webContentsId: 7 }
  );
}

describe("diagnosticsTargetProfile", () => {
  it("prefers the focused window, then the active profile if open, then any open one", () => {
    expect(diagnosticsTargetProfile("p2", "p1", ["p1", "p2"])).toBe("p2");
    expect(diagnosticsTargetProfile(null, "p1", ["p2", "p1"])).toBe("p1");
    expect(diagnosticsTargetProfile(null, "p3", ["p2", "p1"])).toBe("p2");
    expect(diagnosticsTargetProfile(null, "p1", [])).toBeNull();
  });
});

describe("Copy Diagnostics Info", () => {
  let bus: InstanceType<typeof CommandBus>;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(windowsByProfile)) delete windowsByProfile[key];
    bus = new CommandBus();
    registerDiagnosticsCopyHandler(bus, deps);
  });

  it("copies text and HTML from the menu before asking the window for its repository", async () => {
    windowsByProfile["p2"] = { webContents: contents(341) };
    const emit = vi.fn(() => {
      // The report is already on the clipboard when the window is asked.
      expect(mocks.write).toHaveBeenCalledOnce();
    });

    await copyDiagnosticsFromMenu(deps, { focused: null, activeId: "p2" }, emit);

    expect(emit).toHaveBeenCalledWith("p2", true);
    const items = written(0);
    expect(Object.keys(items)).toEqual(["text/plain", "text/html"]);
    const text = items["text/plain"]!;
    expect(text).toContain("Release: Stable / Latest");
    expect(text).toContain("Profile: Work (p2)");
    expect(text).toContain("Open profile windows: Personal, Work");
    expect(text).toContain("Renderer PID: 341");
    expect(text).toContain("Repository: Unavailable (no window answered)");
    expect(text).toContain("Log file: /logs/main.log");
    expect(text).toContain("Git version: git version 2.51.0");
    expect(items["text/html"]).toContain("<pre><code>");
  });

  it("tells the window when the first copy failed", async () => {
    mocks.write.mockRejectedValueOnce(new Error("pasteboard busy"));
    const emit = vi.fn();
    await copyDiagnosticsFromMenu(deps, { focused: "p1", activeId: null }, emit);
    expect(emit).toHaveBeenCalledWith("p1", false);
  });

  it("re-copies with the asking window's repository, profile and renderer pid", async () => {
    await copyDiagnosticsFromMenu(deps, { focused: "p1", activeId: null }, vi.fn());
    mocks.readText.mockResolvedValueOnce(written(0)["text/plain"]!.replace(/\n/g, "\r\n"));

    const result = await recopy(bus);

    expect(result).toEqual({ ok: true, value: { written: true } });
    expect(mocks.fromId).toHaveBeenCalledWith(7);
    const text = written(1)["text/plain"]!;
    expect(text).toContain("Profile: Personal (p1)");
    expect(text).toContain("Renderer PID: 330");
    expect(text).toContain("Repository path: /src/atlas");
    expect(text).toContain("Worktree path: /src/atlas-wt");
    expect(text).toContain("Branch: feat/x");
    expect(text).toContain("Build: Packaged");
  });

  it("keeps what the user copied after the menu's copy", async () => {
    await copyDiagnosticsFromMenu(deps, { focused: "p1", activeId: null }, vi.fn());
    mocks.readText.mockResolvedValueOnce("something the user copied");

    const result = await recopy(bus);

    expect(result).toEqual({ ok: true, value: { written: false } });
    expect(mocks.write).toHaveBeenCalledOnce();
  });

  it("probes Git once for the menu's copy and the window's re-copy", async () => {
    // Past the reuse window of any earlier test's probe.
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ["Date"] });
    try {
      await copyDiagnosticsFromMenu(deps, { focused: "p1", activeId: null }, vi.fn());
      mocks.readText.mockResolvedValueOnce(written(0)["text/plain"]!);
      await recopy(bus);
      expect(mocks.probe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
