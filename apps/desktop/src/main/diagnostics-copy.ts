import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  webContents,
  type WebContents
} from "electron";
import { ok, type DiagnosticsRepositoryContext } from "@pwrgit/shared";
import { readAppIdentity } from "./app-identity";
import type { CommandBus } from "./command-bus";
import {
  buildDiagnosticsReport,
  type DiagnosticsBuild,
  type DiagnosticsGit,
  type DiagnosticsReport
} from "./diagnostics-report";
import { activeGitPath, bundledKeychainHelper, execGit, installedGitSelection } from "./git/dugite";
import { probeGitRuntime } from "./git/runtime-status";
import { currentLogFilePath, logMain } from "./logs";
import { formatProcessIds } from "./process-ids";

let startupBuild: Promise<DiagnosticsBuild> | null = null;

/**
 * The dev checkout, branch and commit the app started from. Read once, early:
 * a checkout that switches branch under a running app would otherwise report
 * a commit that is not the one running.
 */
export function captureDiagnosticsBuild(): Promise<DiagnosticsBuild> {
  startupBuild ??= readBuild();
  return startupBuild;
}

async function readBuild(): Promise<DiagnosticsBuild> {
  if (app.isPackaged) return { kind: "packaged" };
  const result = await execGit(
    ["rev-parse", "--show-toplevel", "HEAD", "--abbrev-ref", "HEAD"],
    app.getAppPath()
  );
  if (!result.ok || result.value.exitCode !== 0) return { kind: "development" };
  const [checkoutPath, commitSha, branch] = result.value.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim());
  if (!checkoutPath || !commitSha || !branch) return { kind: "development" };
  return {
    kind: "development",
    checkoutPath,
    commitSha,
    ...(branch === "HEAD" ? { detachedHead: true } : { branch })
  };
}

/** One click copies twice (main, then the window); both share one probe. */
const GIT_PROBE_REUSE_MS = 30_000;
let gitProbe: { path: string; at: number; result: Promise<DiagnosticsGit> } | null = null;

async function probeGit(path: string, installed: boolean): Promise<DiagnosticsGit> {
  const probed = await probeGitRuntime(path, installed ? "custom" : "bundled");
  return {
    source: installed ? "installed" : "bundled",
    path,
    version: probed.git,
    lfs: probed.lfs,
    keychainHelper: installed ? null : bundledKeychainHelper()
  };
}

function readGit(now = Date.now()): Promise<DiagnosticsGit> {
  const path = activeGitPath();
  if (gitProbe === null || gitProbe.path !== path || now - gitProbe.at > GIT_PROBE_REUSE_MS) {
    gitProbe = { path, at: now, result: probeGit(path, installedGitSelection() !== null) };
  }
  return gitProbe.result;
}

/** The text the menu last put on the clipboard, so the window's re-copy can
 *  tell whether the user has copied something else since. */
let menuCopyText: string | null = null;

/**
 * Who should confirm the copy: the focused profile window, else the active
 * profile's, else any open one. Null when no profile window is open.
 */
export function diagnosticsTargetProfile(
  focused: string | null,
  activeId: string | null,
  open: readonly string[]
): string | null {
  if (focused !== null) return focused;
  if (activeId !== null && open.includes(activeId)) return activeId;
  return open[0] ?? null;
}

export type DiagnosticsCopyDeps = {
  profileName: (profileId: string) => string | null;
  openProfileIds: () => string[];
  profileFor: (window: BrowserWindow | null) => string | null;
  windowFor: (profileId: string) => BrowserWindow | null;
  paths: {
    userData: string;
    database: string;
    settings: string;
    diagnosticsOutput: string;
  };
};

export type DiagnosticsCopyRequest = {
  profileId: string | null;
  sender: WebContents | null;
  /** Undefined when no window was asked. */
  repository?: DiagnosticsRepositoryContext | null;
};

async function buildReport(
  deps: DiagnosticsCopyDeps,
  request: DiagnosticsCopyRequest
): Promise<DiagnosticsReport> {
  const [build, git] = await Promise.all([captureDiagnosticsBuild(), readGit()]);
  const name = (id: string): string => deps.profileName(id) ?? id;
  const rendererPid =
    request.sender !== null && !request.sender.isDestroyed()
      ? request.sender.getOSProcessId()
      : 0;
  return buildDiagnosticsReport({
    collectedAt: new Date(),
    identity: readAppIdentity(),
    build,
    executablePath: process.execPath,
    appPath: app.getAppPath(),
    chromeVersion: process.versions.chrome ?? "unknown",
    nodeVersion: process.versions.node,
    profile:
      request.profileId === null
        ? null
        : { id: request.profileId, name: name(request.profileId) },
    openProfiles: deps.openProfileIds().map(name),
    ...(request.repository === undefined ? {} : { repository: request.repository }),
    mainPid: process.pid,
    // 0 until the renderer's frame has loaded.
    rendererPid: rendererPid > 0 ? rendererPid : null,
    processTable: formatProcessIds(app.getAppMetrics()),
    paths: { ...deps.paths, log: currentLogFilePath() },
    git
  });
}

function writeReport(report: DiagnosticsReport): Promise<void> {
  return clipboard.write([
    new ClipboardItem({ "text/plain": report.text, "text/html": report.html })
  ]);
}

/**
 * Help → Copy Diagnostics Info. The app report goes on the clipboard at once,
 * so a hung or loading window still leaves something to paste; then the
 * target window is asked for its repository and re-copies with it.
 */
export async function copyDiagnosticsFromMenu(
  deps: DiagnosticsCopyDeps,
  target: { focused: string | null; activeId: string | null },
  emit: (profileId: string | null, copied: boolean) => void
): Promise<void> {
  const profileId = diagnosticsTargetProfile(
    target.focused,
    target.activeId,
    deps.openProfileIds()
  );
  let copied = false;
  try {
    const report = await buildReport(deps, {
      profileId,
      sender: profileId === null ? null : (deps.windowFor(profileId)?.webContents ?? null)
    });
    await writeReport(report);
    menuCopyText = report.text;
    copied = true;
  } catch (cause) {
    menuCopyText = null;
    logMain("warn", "diagnostics", "copying diagnostics info failed", cause);
  }
  emit(profileId, copied);
}

/** A pasteboard may hand back CRLF for the LF it was given. */
function sameText(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
}

export function registerDiagnosticsCopyHandler(
  bus: CommandBus,
  deps: DiagnosticsCopyDeps
): void {
  bus.register("app:copyDiagnostics", async (req, context) => {
    const sender =
      context.webContentsId === undefined
        ? null
        : (webContents.fromId(context.webContentsId) ?? null);
    const window = sender === null ? null : BrowserWindow.fromWebContents(sender);
    const report = await buildReport(deps, {
      profileId: deps.profileFor(window),
      sender,
      repository: req.repository
    });
    // The user copied something else since the menu's copy: keep theirs.
    if (menuCopyText !== null && !sameText(await clipboard.readText(), menuCopyText)) {
      return ok({ written: false });
    }
    await writeReport(report);
    menuCopyText = null;
    return ok({ written: true });
  });
}
