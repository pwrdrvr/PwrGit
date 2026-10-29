import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  write: vi.fn(async () => undefined),
  windows: [] as unknown[],
  fromId: vi.fn(),
  fromWebContents: vi.fn()
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getAppPath: () => "/app",
    getAppMetrics: () => [{ pid: 311, type: "Browser" }],
    getName: () => "PwrGit",
    getVersion: () => "0.45.0"
  },
  BrowserWindow: {
    getAllWindows: () => mocks.windows,
    fromWebContents: mocks.fromWebContents
  },
  clipboard: { write: mocks.write },
  ClipboardItem: class {
    constructor(readonly items: Record<string, string>) {}
  },
  webContents: { fromId: mocks.fromId }
}));
vi.mock("./app-identity", () => ({
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
vi.mock("./git/runtime-status", () => ({
  probeGitRuntime: async () => ({ git: "git version 2.51.0", lfs: "git-lfs/3.7.0" })
}));

const {
  copyDiagnosticsFromMenu,
  diagnosticsTargetProfile,
  registerDiagnosticsCopyHandler
} = await import("./diagnostics-copy");
const { CommandBus } = await import("./command-bus");

type Written = { items: Record<string, string> };

function writtenText(call = 0): string {
  const items = (mocks.write.mock.calls[call] as unknown as [Written[]])[0];
  return items[0]!.items["text/plain"]!;
}

function contents(pid: number) {
  return { isDestroyed: () => false, getOSProcessId: () => pid };
}

const deps = {
  profileName: (id: string) => ({ p1: "Personal", p2: "Work" })[id] ?? null,
  openProfileIds: () => ["p1", "p2"],
  profileFor: (window: unknown) =>
    (window as { profileId?: string } | null)?.profileId ?? null,
  paths: {
    userData: "/data",
    database: "/data/pwrgit.db",
    settings: "/data/settings.json",
    diagnosticsOutput: "/data/diagnostics"
  }
};

describe("diagnosticsTargetProfile", () => {
  it("prefers the focused window, then the active profile if open, then any open one", () => {
    expect(diagnosticsTargetProfile("p2", "p1", ["p1", "p2"])).toBe("p2");
    expect(diagnosticsTargetProfile(null, "p1", ["p2", "p1"])).toBe("p1");
    expect(diagnosticsTargetProfile(null, "p3", ["p2", "p1"])).toBe("p2");
    expect(diagnosticsTargetProfile(null, "p1", [])).toBeNull();
  });
});

describe("Copy Diagnostics Info", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.windows = [];
  });

  it("copies text and HTML from the menu before asking the window for its repository", async () => {
    mocks.windows = [
      { profileId: "p2", isDestroyed: () => false, webContents: contents(341) }
    ];
    const emit = vi.fn(() => {
      // The report is already on the clipboard when the window is asked.
      expect(mocks.write).toHaveBeenCalledOnce();
    });

    await copyDiagnosticsFromMenu(deps, { focused: null, activeId: "p2" }, emit);

    expect(emit).toHaveBeenCalledWith("p2");
    const [items] = mocks.write.mock.calls[0] as unknown as [Written[]];
    expect(Object.keys(items[0]!.items)).toEqual(["text/plain", "text/html"]);
    const text = writtenText();
    expect(text).toContain("Profile: Work (p2)");
    expect(text).toContain("Open profile windows: Personal, Work");
    expect(text).toContain("Renderer PID: 341");
    expect(text).toContain("Repository: Unavailable (no window answered)");
    expect(text).toContain("Log file: /logs/main.log");
    expect(text).toContain("Git version: git version 2.51.0");
    expect(items[0]!.items["text/html"]).toContain("<pre><code>");
  });

  it("still asks a window when the first copy fails", async () => {
    mocks.write.mockRejectedValueOnce(new Error("pasteboard busy"));
    const emit = vi.fn();
    await copyDiagnosticsFromMenu(deps, { focused: "p1", activeId: null }, emit);
    expect(emit).toHaveBeenCalledWith("p1");
  });

  it("re-copies with the asking window's repository, profile and renderer pid", async () => {
    const sender = contents(330);
    mocks.fromId.mockReturnValue(sender);
    mocks.fromWebContents.mockReturnValue({ profileId: "p1" });
    const bus = new CommandBus();
    registerDiagnosticsCopyHandler(bus, deps);

    const result = await bus.dispatch(
      "app:copyDiagnostics",
      {
        repository: {
          name: "PwrGit",
          path: "/src/PwrGit",
          worktreePath: "/src/PwrGit-wt",
          branch: "feat/x"
        }
      },
      { webContentsId: 7 }
    );

    expect(result.ok).toBe(true);
    expect(mocks.fromId).toHaveBeenCalledWith(7);
    const text = writtenText();
    expect(text).toContain("Profile: Personal (p1)");
    expect(text).toContain("Renderer PID: 330");
    expect(text).toContain("Repository path: /src/PwrGit");
    expect(text).toContain("Worktree path: /src/PwrGit-wt");
    expect(text).toContain("Branch: feat/x");
    expect(text).toContain("Build: Packaged");
  });
});
