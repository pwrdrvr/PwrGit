import { describe, expect, it } from "vitest";
import {
  executablePathExample,
  isAbsoluteExecutablePath,
  normalizeManualExecutablePath
} from "./executable-path";

describe("isAbsoluteExecutablePath", () => {
  describe.each(["darwin", "linux", undefined])("on %s", (platform) => {
    it("accepts a path from the root", () => {
      expect(isAbsoluteExecutablePath(platform, "/usr/local/bin/codex")).toBe(true);
      expect(isAbsoluteExecutablePath(platform, "/Users/you/My Tools/kimi")).toBe(true);
    });

    it("refuses a relative path, which would resolve against whatever cwd is", () => {
      expect(isAbsoluteExecutablePath(platform, "codex")).toBe(false);
      expect(isAbsoluteExecutablePath(platform, "./bin/codex")).toBe(false);
      // No shell ever sees this string, so nothing expands the tilde.
      expect(isAbsoluteExecutablePath(platform, "~/bin/codex")).toBe(false);
      expect(isAbsoluteExecutablePath(platform, "")).toBe(false);
    });

    it("refuses a Windows path", () => {
      expect(isAbsoluteExecutablePath(platform, String.raw`C:\tools\agent.exe`)).toBe(false);
    });

    it("refuses NUL and line breaks", () => {
      expect(isAbsoluteExecutablePath(platform, "/usr/bin/co\0dex")).toBe(false);
      expect(isAbsoluteExecutablePath(platform, "/usr/bin/codex\n")).toBe(false);
      expect(isAbsoluteExecutablePath(platform, "/usr/bin/codex\r/other")).toBe(false);
    });
  });

  describe("on win32", () => {
    const abs = (candidate: string): boolean => isAbsoluteExecutablePath("win32", candidate);

    it("accepts a drive-absolute path, with either slash", () => {
      expect(abs(String.raw`C:\tools\agent.exe`)).toBe(true);
      expect(abs(String.raw`d:\Program Files\agent.cmd`)).toBe(true);
      expect(abs("C:/tools/agent.exe")).toBe(true);
    });

    it("accepts a UNC path naming both a server and a share", () => {
      expect(abs(String.raw`\\server\share\agent.cmd`)).toBe(true);
      expect(abs("//server/share/agent.cmd")).toBe(true);
    });

    it("refuses a UNC path missing its server or share", () => {
      expect(abs(String.raw`\\server`)).toBe(false);
      expect(abs(String.raw`\\server\\agent.cmd`)).toBe(false);
      expect(abs(String.raw`\\\share\agent.cmd`)).toBe(false);
      expect(abs(String.raw`\\ser:ver\share\agent.cmd`)).toBe(false);
    });

    it("refuses the device namespaces, however they are slashed", () => {
      expect(abs(String.raw`\\?\C:\tools\agent.exe`)).toBe(false);
      expect(abs(String.raw`\\.\pipe\agent`)).toBe(false);
      expect(abs(String.raw`\??\C:\tools\agent.exe`)).toBe(false);
      expect(abs("//?/C:/tools/agent.exe")).toBe(false);
      expect(abs("//./pipe/agent")).toBe(false);
    });

    it("refuses drive-relative and root-relative spellings", () => {
      // `C:tools` resolves against drive C's own current directory, and `\tools`
      // against the current drive — both depend on process state.
      expect(abs(String.raw`C:tools\agent.exe`)).toBe(false);
      expect(abs(String.raw`\tools\agent.exe`)).toBe(false);
      expect(abs("/usr/bin/codex")).toBe(false);
      expect(abs(String.raw`tools\agent.exe`)).toBe(false);
    });

    it("refuses wildcards, quotes and pipes", () => {
      expect(abs(String.raw`C:\tools\*.exe`)).toBe(false);
      expect(abs(String.raw`"C:\tools\agent.exe"`)).toBe(false);
      expect(abs(String.raw`C:\tools\agent.exe|calc`)).toBe(false);
    });

    it("refuses NUL and line breaks", () => {
      expect(abs("C:\\tools\\agent.exe\n")).toBe(false);
      expect(abs("C:\\to\0ols\\agent.exe")).toBe(false);
    });
  });
});

describe("normalizeManualExecutablePath", () => {
  it("trims what was pasted", () => {
    expect(normalizeManualExecutablePath("darwin", "  /opt/homebrew/bin/codex\n")).toEqual({
      ok: true,
      path: "/opt/homebrew/bin/codex"
    });
  });

  it("removes the one pair of quotes Explorer's Copy as path adds", () => {
    expect(
      normalizeManualExecutablePath("win32", String.raw`"C:\Program Files\Agent\agent.exe"`)
    ).toEqual({ ok: true, path: String.raw`C:\Program Files\Agent\agent.exe` });
    expect(normalizeManualExecutablePath("win32", String.raw` "C:\tools\agent.exe" `)).toEqual({
      ok: true,
      path: String.raw`C:\tools\agent.exe`
    });
  });

  it("refuses any other quoting on Windows", () => {
    for (const input of [
      '"',
      '""',
      String.raw`"C:\tools\agent.exe`,
      String.raw`C:\tools\agent.exe"`,
      String.raw`""C:\tools\agent.exe""`,
      String.raw`"C:\a.exe" "C:\b.exe"`
    ]) {
      const result = normalizeManualExecutablePath("win32", input);
      expect(result.ok, input).toBe(false);
      expect(!result.ok && result.error, input).toMatch(/without shell quoting/);
    }
  });

  it("only unwraps quotes on Windows", () => {
    // Nothing on macOS or Linux wraps a copied path in quotes, so one that
    // arrives quoted is simply not a path from the root.
    const result = normalizeManualExecutablePath("darwin", '"/opt/homebrew/bin/codex"');
    expect(result.ok).toBe(false);
  });

  it("checks the unwrapped path is absolute", () => {
    const result = normalizeManualExecutablePath("win32", String.raw`"tools\agent.exe"`);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/drive-absolute/);
  });

  it("says what an absolute path looks like on the platform in hand", () => {
    const posix = normalizeManualExecutablePath("linux", "codex");
    const win = normalizeManualExecutablePath("win32", "codex.exe");
    expect(!posix.ok && posix.error).toMatch(/beginning with \//);
    expect(!win.ok && win.error).toMatch(/drive-absolute/);
    expect(!win.ok && win.error).toMatch(/UNC/);
  });
});

describe("executablePathExample", () => {
  it("gives each platform a path where that executable really tends to live", () => {
    expect(executablePathExample("win32", "codex")).toBe(
      String.raw`C:\Program Files\OpenAI\Codex\bin\codex.exe`
    );
    // npm-installed agent CLIs are .cmd shims on Windows.
    expect(executablePathExample("win32", "kimi")).toBe(
      String.raw`C:\Users\you\AppData\Roaming\npm\kimi.cmd`
    );
    expect(executablePathExample("darwin", "codex")).toBe("/opt/homebrew/bin/codex");
    expect(executablePathExample("darwin", "qwen")).toBe(
      "/Users/you/.nvm/versions/node/vXX/bin/qwen"
    );
    expect(executablePathExample("linux", "codex")).toBe("/home/you/.local/bin/codex");
    expect(executablePathExample(undefined, "grok")).toBe("/home/you/.local/bin/grok");
    // Git's own installers, not an npm prefix.
    expect(executablePathExample("win32", "git")).toBe(String.raw`C:\Program Files\Git\cmd\git.exe`);
    expect(executablePathExample("darwin", "git")).toBe("/usr/local/git/bin/git");
    expect(executablePathExample("linux", "git")).toBe("/home/you/.local/bin/git");
  });

  it.each(["win32", "darwin", "linux", undefined])(
    "offers only placeholders its own field would accept on %s",
    (platform) => {
      for (const executable of ["codex", "grok", "kimi", "qwen", "git"]) {
        const example = executablePathExample(platform, executable);
        expect(isAbsoluteExecutablePath(platform, example), example).toBe(true);
        expect(normalizeManualExecutablePath(platform, example)).toEqual({
          ok: true,
          path: example
        });
      }
    }
  );
});
