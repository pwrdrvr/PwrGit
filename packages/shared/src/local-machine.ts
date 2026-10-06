// What the user calls the machine PwrGit is running on, for copy that scopes a
// setting to "this computer" — the global excludes file, for one. Shared so the
// main process (which writes the scope chip text) and the renderer (which writes
// titles and descriptions) never disagree on the word.

/** "Mac" on macOS, "PC" on Windows, "computer" everywhere else. */
export function localMachineNoun(platform: string | undefined): "Mac" | "PC" | "computer" {
  if (platform === "darwin") return "Mac";
  if (platform === "win32") return "PC";
  return "computer";
}
