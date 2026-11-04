import { describe, expect, it } from "vitest";
import type { AppIdentity } from "@pwrgit/shared";
import { buildDiagnosticsReport, type DiagnosticsInput } from "./diagnostics-report";

const IDENTITY: AppIdentity = {
  name: "PwrGit",
  version: "0.45.0",
  release: { train: "stable", channel: "latest" },
  buildType: "development",
  platform: { name: "macOS", version: "26.1", arch: "arm64" },
  electronVersion: "44.9.3",
  diagnosticsText: ""
};

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    collectedAt: new Date("2026-10-28T12:00:00.000Z"),
    identity: IDENTITY,
    build: {
      kind: "development",
      checkoutPath: "/src/PwrGit",
      branch: "main",
      commitSha: "d4db17d"
    },
    executablePath: "/src/PwrGit/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    appPath: "/src/PwrGit/apps/desktop",
    chromeVersion: "150.0.0.0",
    nodeVersion: "24.22.1",
    profile: { id: "p1", name: "Personal" },
    openProfiles: ["Personal", "Work"],
    repository: {
      name: "PwrGit",
      path: "/src/PwrGit",
      worktreePath: "/src/PwrGit-wt",
      branch: "feat/x"
    },
    mainPid: 311,
    rendererPid: 330,
    processTable: "main=311 gpu=315 renderer=330,341",
    paths: {
      log: "/Users/me/Library/Logs/PwrGit/main.log",
      userData: "/Users/me/Library/Application Support/PwrGit",
      database: "/Users/me/Library/Application Support/PwrGit/pwrgit.db",
      settings: "/Users/me/Library/Application Support/PwrGit/settings.json",
      diagnosticsOutput: "/Users/me/Library/Application Support/PwrGit/diagnostics"
    },
    git: {
      source: "bundled",
      path: "/app/git/bin/git",
      version: "git version 2.51.0",
      lfs: "git-lfs/3.7.0",
      keychainHelper: "/opt/homebrew/bin/git-credential-osxkeychain"
    },
    ...overrides
  };
}

describe("buildDiagnosticsReport", () => {
  it("reports the build, window, processes, paths and Git in labeled sections", () => {
    const { text } = buildDiagnosticsReport(input());
    expect(text).toBe(
      [
        "PwrGit diagnostics — collected 2026-10-28T12:00:00.000Z",
        "",
        "[App]",
        "Version: PwrGit 0.45.0",
        "Release: Stable / Latest",
        "Build: Development",
        "Executable: /src/PwrGit/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        "App path: /src/PwrGit/apps/desktop",
        "Development checkout: /src/PwrGit",
        "Development branch (startup): main",
        "Development commit (startup): d4db17d",
        "",
        "[Platform]",
        "OS: macOS 26.1 (arm64)",
        "Electron: 44.9.3",
        "Chrome: 150.0.0.0",
        "Node: 24.22.1",
        "",
        "[Window]",
        "Profile: Personal (p1)",
        "Open profile windows: Personal, Work",
        "Repository: PwrGit",
        "Repository path: /src/PwrGit",
        "Worktree path: /src/PwrGit-wt",
        "Branch: feat/x",
        "",
        "[Processes]",
        "Main PID: 311",
        "Renderer PID: 330",
        "All processes: main=311 gpu=315 renderer=330,341",
        "",
        "[Paths]",
        "Log file: /Users/me/Library/Logs/PwrGit/main.log",
        "User data: /Users/me/Library/Application Support/PwrGit",
        "Database: /Users/me/Library/Application Support/PwrGit/pwrgit.db",
        "Settings: /Users/me/Library/Application Support/PwrGit/settings.json",
        "Diagnostics output: /Users/me/Library/Application Support/PwrGit/diagnostics",
        "",
        "[Git]",
        "Git: Bundled",
        "Git executable: /app/git/bin/git",
        "Git version: git version 2.51.0",
        "Git LFS version: git-lfs/3.7.0",
        "Keychain helper: /opt/homebrew/bin/git-credential-osxkeychain"
      ].join("\n")
    );
  });

  it("leaves out checkout facts from a packaged build", () => {
    const { text } = buildDiagnosticsReport(input({ build: { kind: "packaged" } }));
    expect(text).toContain("Build: Packaged");
    expect(text).not.toContain("Development checkout");
  });

  it("says what is missing rather than printing blanks", () => {
    const unanswered = input({
      build: { kind: "development", detachedHead: true },
      profile: null,
      openProfiles: [],
      rendererPid: null,
      processTable: "",
      paths: { ...input().paths, log: null },
      git: {
        source: "installed",
        path: "/usr/bin/git",
        version: null,
        lfs: null,
        keychainHelper: null
      }
    });
    delete unanswered.repository;
    const { text } = buildDiagnosticsReport(unanswered);
    expect(text).toContain("Development checkout: Unavailable");
    expect(text).toContain("Development branch (startup): Detached HEAD");
    expect(text).toContain("Profile: No profile window open");
    expect(text).toContain("Open profile windows: None");
    expect(text).toContain("Repository: Unavailable (no window answered)");
    expect(text).toContain("Renderer PID: Unavailable");
    expect(text).toContain("All processes: Unavailable");
    expect(text).toContain("Log file: Unavailable");
    expect(text).toContain("Git: Installed (chosen in Settings)");
    expect(text).toContain("Git version: Unavailable");
    expect(text).not.toContain("Keychain helper");
  });

  it("distinguishes a window with no repository selected", () => {
    const { text } = buildDiagnosticsReport(input({ repository: null }));
    expect(text).toContain("Repository: None selected");
    expect(text).not.toContain("Repository path");
  });

  it("copies the same text as an escaped code block for rich editors", () => {
    const report = buildDiagnosticsReport(
      input({
        repository: {
          name: "<script>&co",
          path: "/src/a&b",
          worktreePath: null,
          branch: null
        }
      })
    );
    expect(report.html.startsWith("<pre><code>PwrGit diagnostics")).toBe(true);
    expect(report.html.endsWith("</code></pre>")).toBe(true);
    expect(report.html).toContain("Repository: &lt;script&gt;&amp;co");
    expect(report.html).not.toContain("<script>");
    expect(report.text).toContain("Repository: <script>&co");
  });
});
