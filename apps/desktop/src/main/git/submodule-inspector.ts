import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  err,
  ok,
  type PwrGitError,
  type Result,
  type SubmoduleCheckoutState,
  type SubmoduleIssue,
  type SubmoduleRelation,
  type SubmoduleSnapshot,
  type SubmoduleStatus
} from "@pwrgit/shared";
import { mapLimit } from "../util/map-limit";
import {
  NO_OPTIONAL_LOCKS,
  requireExit0,
  type GitExec,
  type GitExecOptions,
  type GitRecordExec,
  type GitRecordOutput
} from "./dugite";

/** Keep a corrupt/cyclic fixture or huge vendor tree from turning one click
 *  into an unbounded repository walk. Twenty direct children stay well below
 *  this ceiling. */
export const SUBMODULE_SCAN_LIMIT = 200;
export const SUBMODULE_DEPTH_LIMIT = 8;
export const SUBMODULE_INSPECT_CONCURRENCY = 4;
export const SUBMODULE_METADATA_CHAR_LIMIT = 2_000_000;

type Gitlink = { path: string; commit: string };
type IndexGitlink = { path: string; commit: string; stage: number };
type ConfigEntry = {
  name: string;
  path?: string;
  url?: string;
  branch?: string;
  active?: string;
};

type ParentMetadata = {
  headLinks: Map<string, string>;
  indexLinks: Map<string, IndexGitlink[]>;
  entries: ConfigEntry[];
  localEntries: Map<string, ConfigEntry>;
  modulesGitDir: string | null;
  truncated: boolean;
  issues: SubmoduleIssue[];
};

type ParentScan = {
  path: string;
  displayPrefix: string;
  depth: number;
};

type ChildCandidate = {
  parent: ParentScan;
  path: string;
  config: ConfigEntry | null;
  duplicateConfig: boolean;
  pinnedCommit?: string;
  indexLinks: IndexGitlink[];
  localConfig: ConfigEntry | null;
  modulesGitDir: string | null;
};

type InspectedChild = {
  row: SubmoduleStatus;
  nestedParent: ParentScan | null;
  depthTruncated: boolean;
};

const issue = (
  code: SubmoduleIssue["code"],
  severity: SubmoduleIssue["severity"],
  message: string,
  remedy?: string
): SubmoduleIssue =>
  remedy === undefined
    ? { code, severity, message }
    : { code, severity, message, remedy };

/** `git ls-tree -z HEAD` parser. Git paths may contain spaces/newlines, so the
 *  NUL terminator and the metadata/path tab are the only safe boundaries. */
export function parseHeadGitlinks(stdout: string): Gitlink[] {
  const links: Gitlink[] = [];
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(" ");
    if (meta[0] !== "160000" || meta[1] !== "commit" || meta[2] === undefined) {
      continue;
    }
    links.push({ path: record.slice(tab + 1), commit: meta[2] });
  }
  return links;
}

/** `git ls-files --stage -z` parser, retaining conflict stages. */
export function parseIndexGitlinks(stdout: string): IndexGitlink[] {
  const links: IndexGitlink[] = [];
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, commit, stageRaw] = record.slice(0, tab).split(" ");
    if (mode !== "160000" || commit === undefined || stageRaw === undefined) {
      continue;
    }
    const stage = Number(stageRaw);
    if (!Number.isInteger(stage)) continue;
    links.push({ path: record.slice(tab + 1), commit, stage });
  }
  return links;
}

/** `git config --null --get-regexp` emits `key\nvalue\0`. The subsection is
 *  greedy because submodule names commonly contain dots. */
export function parseSubmoduleConfig(stdout: string): ConfigEntry[] {
  const byName = new Map<string, ConfigEntry>();
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const newline = record.indexOf("\n");
    if (newline < 0) continue;
    const key = record.slice(0, newline);
    const value = record.slice(newline + 1);
    const match = /^submodule\.(.*)\.(path|url|branch|active)$/i.exec(key);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      continue;
    }
    const name = match[1];
    const entry = byName.get(name) ?? { name };
    const field = match[2].toLowerCase() as
      | "path"
      | "url"
      | "branch"
      | "active";
    entry[field] = value;
    byName.set(name, entry);
  }
  return [...byName.values()];
}

type ParsedCheckout = {
  commit?: string;
  branch?: string;
  detached: boolean;
  dirty: boolean;
};

/** Parse NUL-delimited porcelain v2 so odd filenames never become fake rows. */
export function parseCheckoutStatus(stdout: string): ParsedCheckout {
  let commit: string | undefined;
  let branch: string | undefined;
  let detached = false;
  let dirty = false;
  for (const record of stdout.split("\0")) {
    if (record.startsWith("# branch.oid ")) {
      const value = record.slice(13).trim();
      if (value !== "" && value !== "(initial)") commit = value;
    } else if (record.startsWith("# branch.head ")) {
      const value = record.slice(14).trim();
      detached = value === "(detached)";
      if (value !== "" && !detached) branch = value;
    } else if (record !== "" && !record.startsWith("# ")) {
      dirty = true;
    }
  }
  return {
    ...(commit === undefined ? {} : { commit }),
    ...(branch === undefined ? {} : { branch }),
    detached,
    dirty
  };
}

function relationFromCounts(stdout: string): SubmoduleRelation | null {
  const [pinOnlyRaw, checkoutOnlyRaw] = stdout.trim().split(/\s+/);
  const pinOnly = Number(pinOnlyRaw);
  const checkoutOnly = Number(checkoutOnlyRaw);
  if (!Number.isFinite(pinOnly) || !Number.isFinite(checkoutOnly)) return null;
  if (pinOnly === 0 && checkoutOnly === 0) return "at_pin";
  if (pinOnly === 0) return "ahead_of_pin";
  if (checkoutOnly === 0) return "behind_pin";
  return "diverged_from_pin";
}

function childGitOptions(parentPath: string): GitExecOptions {
  return {
    env: {
      ...NO_OPTIONAL_LOCKS.env,
      // An empty, uninitialized submodule directory sits inside the parent.
      // Without a ceiling, Git walks upward and reports the PARENT as though it
      // were the child checkout.
      GIT_CEILING_DIRECTORIES: parentPath
    }
  };
}

function localModuleGitDir(
  modulesGitDir: string | null,
  name: string
): string | null {
  if (modulesGitDir === null || name === "") return null;
  const root = modulesGitDir;
  const candidate = resolve(root, ...name.split("/"));
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    return null;
  }
  return candidate;
}

function isEmptyDirectory(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function isRelativeUrl(url: string): boolean {
  return url.startsWith("./") || url.startsWith("../");
}

function normalizedUrl(url: string): string {
  return url.replace(/\\/g, "/").replace(/\/+$/, "");
}

function urlReallyChanged(declared: string, initialized: string): boolean {
  // Git resolves relative declarations before copying them to local config;
  // the strings are expected to differ and do not prove a stale URL.
  if (isRelativeUrl(declared)) return false;
  return normalizedUrl(declared) !== normalizedUrl(initialized);
}

async function optionalOutput(
  git: GitExec,
  args: string[],
  cwd: string,
  options: GitExecOptions = NO_OPTIONAL_LOCKS
): Promise<string | null> {
  const raw = await git(args, cwd, options);
  return raw.ok && raw.value.exitCode === 0 ? raw.value.stdout : null;
}

function recordsAsOutput(output: GitRecordOutput): string {
  return output.records.length === 0 ? "" : `${output.records.join("\0")}\0`;
}

function requireRecordExit0(
  output: GitRecordOutput,
  args: string[]
): Result<GitRecordOutput, PwrGitError> {
  if (output.exitCode === 0) return ok(output);
  return err({
    kind: "git",
    code: `exit_${output.exitCode}`,
    message:
      output.stderr.trim() !== ""
        ? output.stderr.trim()
        : `git ${args.join(" ")} exited ${output.exitCode}`
  });
}

async function readParentMetadata(
  git: GitExec,
  recordGit: GitRecordExec,
  parentPath: string,
  limit: number
): Promise<Result<ParentMetadata, PwrGitError>> {
  const keepGitlink = (record: string): boolean =>
    record.startsWith("160000 ");
  const configLimit = Math.max(limit * 4, 4);
  const [indexRaw, headRaw, declaredRaw, localRaw, modulesRaw] =
    await Promise.all([
      recordGit(["ls-files", "--stage", "-z"], parentPath, {
        ...NO_OPTIONAL_LOCKS,
        maxRecords: limit,
        maxChars: SUBMODULE_METADATA_CHAR_LIMIT,
        matches: keepGitlink
      }),
      // Recursive is about ordinary parent trees (`modules/…`); traversal
      // stops at a 160000 gitlink and never enters the child repository.
      // The streaming reader discards ordinary entries as they arrive, so a
      // million-file tree never becomes a million-entry JavaScript string.
      recordGit(["ls-tree", "-r", "-z", "HEAD"], parentPath, {
        ...NO_OPTIONAL_LOCKS,
        maxRecords: limit,
        maxChars: SUBMODULE_METADATA_CHAR_LIMIT,
        matches: keepGitlink
      }),
      existsSync(resolve(parentPath, ".gitmodules"))
        ? recordGit(
            [
              "config",
              "--null",
              "--file",
              ".gitmodules",
              "--get-regexp",
              "^submodule\\..*\\.(path|url|branch)$"
            ],
            parentPath,
            {
              ...NO_OPTIONAL_LOCKS,
              maxRecords: configLimit,
              maxChars: SUBMODULE_METADATA_CHAR_LIMIT,
              matches: () => true
            }
          )
        : Promise.resolve(null),
      recordGit(
        [
          "config",
          "--null",
          "--local",
          "--get-regexp",
          "^submodule\\..*\\.(url|branch|active)$"
        ],
        parentPath,
        {
          ...NO_OPTIONAL_LOCKS,
          maxRecords: configLimit,
          maxChars: SUBMODULE_METADATA_CHAR_LIMIT,
          matches: () => true
        }
      ),
      // --git-path is worktree-aware. In a linked worktree this resolves to
      // .git/worktrees/<id>/modules rather than the common checkout's store.
      git(["rev-parse", "--git-path", "modules"], parentPath, NO_OPTIONAL_LOCKS)
    ]);

  if (!indexRaw.ok) return indexRaw;
  const index = requireRecordExit0(indexRaw.value, [
    "ls-files",
    "--stage",
    "-z"
  ]);
  if (!index.ok) return index;

  const issues: SubmoduleIssue[] = [];
  let entries: ConfigEntry[] = [];
  if (declaredRaw !== null) {
    if (!declaredRaw.ok || declaredRaw.value.exitCode > 1) {
      const message = declaredRaw.ok
        ? declaredRaw.value.stderr.trim() || "Git could not parse .gitmodules."
        : declaredRaw.error.message;
      issues.push(
        issue(
          "inspect_failed",
          "error",
          message,
          "Repair .gitmodules, then refresh the submodule scan."
        )
      );
    } else if (declaredRaw.value.exitCode === 0) {
      entries = parseSubmoduleConfig(recordsAsOutput(declaredRaw.value));
    }
  }

  const localEntries = new Map<string, ConfigEntry>();
  if (localRaw.ok && localRaw.value.exitCode === 0) {
    for (const entry of parseSubmoduleConfig(recordsAsOutput(localRaw.value))) {
      localEntries.set(entry.name, entry);
    }
  }

  const headLinks = new Map<string, string>();
  if (headRaw.ok && headRaw.value.exitCode === 0) {
    for (const link of parseHeadGitlinks(recordsAsOutput(headRaw.value))) {
      headLinks.set(link.path, link.commit);
    }
  }

  const indexLinks = new Map<string, IndexGitlink[]>();
  for (const link of parseIndexGitlinks(recordsAsOutput(index.value))) {
    const current = indexLinks.get(link.path) ?? [];
    current.push(link);
    indexLinks.set(link.path, current);
  }

  let modulesGitDir: string | null = null;
  if (modulesRaw.ok && modulesRaw.value.exitCode === 0) {
    const value = modulesRaw.value.stdout.trim();
    if (value !== "") modulesGitDir = resolve(parentPath, value);
  }

  return ok({
    headLinks,
    indexLinks,
    entries,
    localEntries,
    modulesGitDir,
    truncated:
      index.value.truncated ||
      (headRaw.ok && headRaw.value.truncated) ||
      (declaredRaw?.ok === true && declaredRaw.value.truncated) ||
      (localRaw.ok && localRaw.value.truncated),
    issues
  });
}

function childCandidates(
  parent: ParentScan,
  metadata: ParentMetadata
): ChildCandidate[] {
  const entriesByPath = new Map<string, ConfigEntry[]>();
  for (const entry of metadata.entries) {
    if (entry.path === undefined || entry.path === "") continue;
    const current = entriesByPath.get(entry.path) ?? [];
    current.push(entry);
    entriesByPath.set(entry.path, current);
  }
  const paths = new Set<string>([
    ...metadata.headLinks.keys(),
    ...metadata.indexLinks.keys(),
    ...entriesByPath.keys()
  ]);
  return [...paths]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const configs = entriesByPath.get(path) ?? [];
      const config = configs[0] ?? null;
      const pinnedCommit = metadata.headLinks.get(path);
      return {
        parent,
        path,
        config,
        duplicateConfig: configs.length > 1,
        ...(pinnedCommit === undefined ? {} : { pinnedCommit }),
        indexLinks: metadata.indexLinks.get(path) ?? [],
        localConfig:
          config === null
            ? (metadata.localEntries.get(path) ?? null)
            : (metadata.localEntries.get(config.name) ?? null),
        modulesGitDir: metadata.modulesGitDir
      };
    });
}

async function inspectChild(
  git: GitExec,
  candidate: ChildCandidate
): Promise<InspectedChild> {
  const { parent, config } = candidate;
  const name = config?.name ?? candidate.path;
  const displayPath =
    parent.displayPrefix === ""
      ? candidate.path
      : `${parent.displayPrefix}/${candidate.path}`;
  const path = resolve(parent.path, ...candidate.path.split("/"));
  const relativePath = relative(parent.path, path);
  const indexStage0 = candidate.indexLinks.find((entry) => entry.stage === 0);
  const conflictStages = candidate.indexLinks.filter(
    (entry) => entry.stage !== 0
  );
  const expectedCommit = indexStage0?.commit ?? candidate.pinnedCommit;
  const issues: SubmoduleIssue[] = [];

  if (config === null) {
    issues.push(
      issue(
        "gitmodules_entry_missing",
        "error",
        "The parent records a gitlink here, but .gitmodules has no matching path.",
        "Restore the matching .gitmodules entry before another clone needs this submodule."
      )
    );
  } else if (config.url === undefined || config.url === "") {
    issues.push(
      issue(
        "url_missing",
        "error",
        ".gitmodules does not declare a URL for this submodule.",
        "Add submodule.<name>.url before trying to initialize it."
      )
    );
  }
  if (
    candidate.pinnedCommit === undefined &&
    candidate.indexLinks.length === 0
  ) {
    issues.push(
      issue(
        "gitlink_missing",
        "error",
        ".gitmodules declares this path, but the parent does not record a 160000 gitlink.",
        "Remove the stale entry or add and commit the submodule path."
      )
    );
  }
  if (candidate.duplicateConfig) {
    issues.push(
      issue(
        "inspect_failed",
        "error",
        "More than one .gitmodules section declares this path.",
        "Keep one section per submodule path."
      )
    );
  }
  if (conflictStages.length > 0) {
    issues.push(
      issue(
        "index_conflict",
        "error",
        "The parent index has an unresolved submodule gitlink conflict.",
        "Resolve the parent merge before updating the submodule checkout."
      )
    );
  }

  const configuredUrl = config?.url;
  const initializedUrl = candidate.localConfig?.url;
  if (
    configuredUrl !== undefined &&
    initializedUrl !== undefined &&
    urlReallyChanged(configuredUrl, initializedUrl)
  ) {
    issues.push(
      issue(
        "url_changed",
        "warning",
        "The initialized URL differs from the current .gitmodules URL.",
        "Review the new endpoint, then run submodule sync before fetching."
      )
    );
  }

  const outsideParent =
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);
  let checkoutState: SubmoduleCheckoutState;
  let checkout: ParsedCheckout | null = null;
  if (outsideParent || !existsSync(path)) {
    checkoutState = "missing";
    issues.push(
      issue(
        "checkout_missing",
        "error",
        "The submodule checkout path is missing.",
        "Initialize this path from the parent repository after reviewing its URL."
      )
    );
  } else {
    const status = await git(
      [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=normal",
        "--ignore-submodules=all"
      ],
      path,
      childGitOptions(parent.path)
    );
    if (status.ok && status.value.exitCode === 0) {
      checkoutState = "checked_out";
      checkout = parseCheckoutStatus(status.value.stdout);
    } else {
      const moduleDir = localModuleGitDir(candidate.modulesGitDir, name);
      const retained = moduleDir !== null && existsSync(moduleDir);
      if (isEmptyDirectory(path)) {
        checkoutState = retained ? "deinitialized" : "uninitialized";
        issues.push(
          retained
            ? issue(
                "checkout_deinitialized",
                "warning",
                "This submodule was deinitialized; its Git data is still retained locally.",
                "Reinitialize it from the parent after reviewing the configured URL."
              )
            : issue(
                "checkout_uninitialized",
                "warning",
                "This submodule has not been initialized.",
                "Initialize it from the parent after reviewing the configured URL."
              )
        );
      } else {
        checkoutState = "not_repository";
        issues.push(
          issue(
            "checkout_not_repository",
            "error",
            "The path exists but is not this submodule's Git checkout.",
            "Preserve or move the existing files, then initialize the submodule."
          )
        );
      }
    }
  }

  let relation: SubmoduleRelation = "unknown";
  const checkedOutCommit = checkout?.commit;
  if (expectedCommit !== undefined && checkedOutCommit !== undefined) {
    if (expectedCommit === checkedOutCommit) {
      relation = "at_pin";
    } else {
      const counts = await optionalOutput(
        git,
        [
          "rev-list",
          "--left-right",
          "--count",
          `${expectedCommit}...${checkedOutCommit}`
        ],
        path,
        childGitOptions(parent.path)
      );
      relation =
        counts === null
          ? "unknown"
          : (relationFromCounts(counts) ?? "unknown");
      if (relation === "unknown") {
        issues.push(
          issue(
            "commit_unavailable",
            "warning",
            "Git could not compare the checkout with the parent pin; an object may be missing.",
            "Fetch from the reviewed initialized URL, then refresh this scan."
          )
        );
      }
    }
  }

  let pinnedTags: string[] = [];
  const tagCommit = candidate.pinnedCommit ?? indexStage0?.commit;
  if (checkoutState === "checked_out" && tagCommit !== undefined) {
    const tags = await optionalOutput(
      git,
      [
        "for-each-ref",
        `--points-at=${tagCommit}`,
        "--format=%(refname:short)",
        "refs/tags"
      ],
      path,
      childGitOptions(parent.path)
    );
    if (tags !== null) {
      pinnedTags = tags
        .split(/\r?\n/)
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "")
        .sort((a, b) => a.localeCompare(b));
    }
  }

  const row: SubmoduleStatus = {
    name,
    path: displayPath,
    depth: parent.depth,
    ...(candidate.pinnedCommit === undefined
      ? {}
      : { pinnedCommit: candidate.pinnedCommit }),
    ...(indexStage0 === undefined ? {} : { indexCommit: indexStage0.commit }),
    ...(checkedOutCommit === undefined ? {} : { checkedOutCommit }),
    checkoutState,
    relation,
    dirty: checkout?.dirty ?? null,
    detached: checkout?.detached ?? null,
    ...(checkout?.branch === undefined
      ? {}
      : { checkedOutBranch: checkout.branch }),
    pinnedTags,
    ...(configuredUrl === undefined ? {} : { configuredUrl }),
    ...(config?.branch === undefined
      ? {}
      : { configuredBranch: config.branch }),
    ...(initializedUrl === undefined ? {} : { initializedUrl }),
    issues
  };
  const hasNestedModules =
    checkoutState === "checked_out" &&
    existsSync(resolve(path, ".gitmodules"));
  const canInspectNested = parent.depth + 1 <= SUBMODULE_DEPTH_LIMIT;
  return {
    row,
    nestedParent:
      hasNestedModules && canInspectNested
        ? { path, displayPrefix: displayPath, depth: parent.depth + 1 }
        : null,
    depthTruncated: hasNestedModules && !canInspectNested
  };
}

/**
 * Inspect every direct and initialized nested submodule beneath a worktree.
 * Child failures are data, not command failures: one broken URL/path must not
 * hide its healthy siblings or poison the parent's normal status pipeline.
 */
export async function inspectSubmodules(
  git: GitExec,
  recordGit: GitRecordExec,
  worktreePath: string
): Promise<Result<SubmoduleSnapshot, PwrGitError>> {
  const rows: SubmoduleStatus[] = [];
  const issues: SubmoduleIssue[] = [];
  const queue: ParentScan[] = [
    { path: worktreePath, displayPrefix: "", depth: 0 }
  ];
  let truncated = false;

  while (queue.length > 0 && rows.length < SUBMODULE_SCAN_LIMIT) {
    const parent = queue.shift();
    if (parent === undefined) break;
    const metadata = await readParentMetadata(
      git,
      recordGit,
      parent.path,
      SUBMODULE_SCAN_LIMIT - rows.length
    );
    if (!metadata.ok) {
      if (parent.depth === 0) return metadata;
      const owner = rows.find((row) => row.path === parent.displayPrefix);
      owner?.issues.push(
        issue(
          "inspect_failed",
          "error",
          `Nested submodules could not be inspected: ${metadata.error.message}`,
          "Repair this checkout, then refresh the submodule scan."
        )
      );
      continue;
    }
    issues.push(...metadata.value.issues);
    if (metadata.value.truncated) truncated = true;
    const candidates = childCandidates(parent, metadata.value);
    const room = SUBMODULE_SCAN_LIMIT - rows.length;
    const selected = candidates.slice(0, room);
    if (selected.length < candidates.length) truncated = true;

    const inspected: InspectedChild[] = [];
    await mapLimit(
      selected,
      SUBMODULE_INSPECT_CONCURRENCY,
      async (candidate) => {
        try {
          inspected.push(await inspectChild(git, candidate));
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          inspected.push({
            row: {
              name: candidate.config?.name ?? candidate.path,
              path:
                parent.displayPrefix === ""
                  ? candidate.path
                  : `${parent.displayPrefix}/${candidate.path}`,
              depth: parent.depth,
              ...(candidate.pinnedCommit === undefined
                ? {}
                : { pinnedCommit: candidate.pinnedCommit }),
              checkoutState: "not_repository",
              relation: "unknown",
              dirty: null,
              detached: null,
              pinnedTags: [],
              issues: [
                issue(
                  "inspect_failed",
                  "error",
                  `Submodule inspection failed: ${message}`,
                  "Open the app logs for the Git diagnostic, then refresh."
                )
              ]
            },
            nestedParent: null,
            depthTruncated: false
          });
        }
      }
    );
    inspected.sort((a, b) => a.row.path.localeCompare(b.row.path));
    for (const child of inspected) {
      rows.push(child.row);
      if (child.nestedParent !== null) queue.push(child.nestedParent);
      if (child.depthTruncated) truncated = true;
    }
  }

  if (queue.length > 0) truncated = true;
  if (truncated) {
    issues.push(
      issue(
        "scan_truncated",
        "warning",
        `The submodule scan reached its safety limit (${SUBMODULE_SCAN_LIMIT} entries or ${SUBMODULE_DEPTH_LIMIT} nested levels).`,
        "Inspect the remaining nested repositories with Git directly."
      )
    );
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return ok({ submodules: rows, truncated, issues });
}
