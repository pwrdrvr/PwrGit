import { ok, type GitLfsStatus, type Result } from "@pwrgit/shared";
import { requireExit0, type GitExec } from "./dugite";

const LFS_ATTRIBUTE = /(?:^|\s)filter=lfs(?:\s|$)/;

/** True when a tracked attributes file contains an active Git LFS filter. */
export function attributesRequireLfs(contents: string): boolean {
  return contents.split("\n").some((line) => {
    const trimmed = line.trim();
    return (
      trimmed !== "" &&
      !trimmed.startsWith("#") &&
      LFS_ATTRIBUTE.test(trimmed)
    );
  });
}

function lfsFiltersConfigured(stdout: string): boolean {
  const config = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const separator = line.search(/\s/);
    if (separator < 0) continue;
    config.set(
      line.slice(0, separator).toLowerCase(),
      line.slice(separator).trim()
    );
  }
  return (
    config.get("filter.lfs.required")?.toLowerCase() === "true" &&
    config.get("filter.lfs.process")?.includes("git-lfs filter-process") ===
      true &&
    config.get("filter.lfs.clean")?.includes("git-lfs clean") === true &&
    config.get("filter.lfs.smudge")?.includes("git-lfs smudge") === true
  );
}

/** Inspect tracked attributes first, then probe LFS only when this checkout
 * actually asks Git to use it. All commands run through PwrGit's Git runtime,
 * so the result describes whether PwrGit can materialize this worktree. */
export async function inspectGitLfs(
  git: GitExec,
  cwd: string
): Promise<Result<GitLfsStatus>> {
  const listed = await git(
    ["ls-files", "-z", "--", ".gitattributes", ":(glob)**/.gitattributes"],
    cwd
  );
  if (!listed.ok) return listed;
  const checkedList = requireExit0(listed.value, ["ls-files"]);
  if (!checkedList.ok) return checkedList;

  const paths = [
    ...new Set(checkedList.value.stdout.split("\0").filter(Boolean))
  ];
  let required = false;
  for (const path of paths) {
    const shown = await git(["show", `:./${path}`], cwd);
    if (!shown.ok) return shown;
    if (shown.value.exitCode !== 0) continue;
    if (attributesRequireLfs(shown.value.stdout)) {
      required = true;
      break;
    }
  }
  if (!required) return ok({ required: false });

  const [version, filters] = await Promise.all([
    git(["lfs", "version"], cwd),
    git(["config", "--get-regexp", "^filter\\.lfs\\."], cwd)
  ]);
  if (!version.ok) return version;
  if (!filters.ok) return filters;

  const installed = version.value.exitCode === 0;
  const status: GitLfsStatus = {
    required: true,
    installed,
    configured:
      filters.value.exitCode === 0 &&
      lfsFiltersConfigured(filters.value.stdout)
  };
  const versionText = version.value.stdout.trim();
  if (installed && versionText !== "") status.version = versionText;
  return ok(status);
}
