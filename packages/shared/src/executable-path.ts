// The "manual executable path" contract behind Settings → AI Providers' path
// fields, shared so the renderer's inline validation and main's sanitizer
// agree on what a path is. Ported from PwrSnap's `desktop-platform.ts`.
//
// Pure string rules, never the host's `path` module: a Windows drive or UNC
// path has to be testable on a macOS runner, and the renderer has no `path`.

/** A realistic example for a path field's placeholder, per platform. */
export function executablePathExample(platform: string | undefined, executable: string): string {
  if (platform === "win32") {
    return executable === "codex"
      ? String.raw`C:\Program Files\OpenAI\Codex\bin\codex.exe`
      : `${String.raw`C:\Users\you\AppData\Roaming\npm`}\\${executable}.cmd`;
  }
  if (platform === "darwin") {
    return executable === "codex"
      ? "/opt/homebrew/bin/codex"
      : `/Users/you/.nvm/versions/node/vXX/bin/${executable}`;
  }
  return `/home/you/.local/bin/${executable}`;
}

/**
 * Whether `candidate` is an absolute path to launch directly. The executable
 * is spawned without a shell, so a relative path would resolve against
 * whatever the working directory happens to be — never what was meant.
 * Drive-relative (`C:tools`) and device-namespace (`\\?\`, `\\.\`) spellings
 * are refused on Windows.
 */
export function isAbsoluteExecutablePath(platform: string | undefined, candidate: string): boolean {
  if (candidate.length === 0 || /[\0\r\n]/.test(candidate)) return false;
  if (platform !== "win32") return candidate.startsWith("/");
  const normalized = candidate.replaceAll("/", "\\");
  if (/[*?"<>|]/.test(normalized)) return false;
  if (
    normalized.startsWith("\\??\\") ||
    normalized.startsWith("\\\\?\\") ||
    normalized.startsWith("\\\\.\\")
  ) {
    return false;
  }
  if (/^[A-Za-z]:\\/.test(normalized)) return true;
  if (!normalized.startsWith("\\\\")) return false;
  const [server = "", share = ""] = normalized.slice(2).split("\\");
  const invalidPart = /[\\/:*?"<>|]/;
  return (
    server.length > 0 && share.length > 0 && !invalidPart.test(server) && !invalidPart.test(share)
  );
}

export type ManualExecutablePathResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Normalize one path pasted into a manual executable field. Explorer's "Copy
 * as path" wraps the path in one pair of double quotes; those describe the
 * clipboard text, not the filename, so exactly that pair is removed. Any other
 * quoting stays invalid, because no shell ever sees this string.
 */
export function normalizeManualExecutablePath(
  platform: string | undefined,
  input: string
): ManualExecutablePathResult {
  let candidate = input.trim();
  if (platform === "win32" && (candidate.startsWith('"') || candidate.endsWith('"'))) {
    const paired = candidate.length >= 2 && candidate.startsWith('"') && candidate.endsWith('"');
    const inner = paired ? candidate.slice(1, -1) : "";
    if (!paired || inner.length === 0 || inner.includes('"')) {
      return { ok: false, error: "Paste one full Windows executable path without shell quoting." };
    }
    candidate = inner;
  }
  if (!isAbsoluteExecutablePath(platform, candidate)) {
    return {
      ok: false,
      error:
        platform === "win32"
          ? String.raw`Enter a drive-absolute path such as C:\tools\agent.exe or a UNC path such as \\server\share\agent.cmd.`
          : "Enter an absolute executable path beginning with /."
    };
  }
  return { ok: true, path: candidate };
}
