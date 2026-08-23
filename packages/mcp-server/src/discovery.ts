import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import type { CommandRunner } from "./command.js";
import { git } from "./command.js";
import {
  parseRepositoryTarget,
  targetMatchesRemote,
  type RepositoryTarget
} from "./remote.js";
import {
  parseWorktreeList,
  parentOfRepository,
  readConfiguredRemotes,
  repositoryRootFor
} from "./git-metadata.js";
import type { RemoteIdentity } from "./types.js";

const SKIP_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".npm",
  ".pnpm-store",
  ".Trash",
  "Library",
  "Applications",
  "build",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor"
]);

export const DEFAULT_SCAN_DEPTH = 4;
export const MAX_SCAN_DEPTH = 5;
export const DEFAULT_DIRECTORY_BUDGET = 5_000;
export const MAX_TOTAL_DIRECTORY_BUDGET = 20_000;
export const MAX_REPOSITORIES_INSPECTED = 500;

export type ScanResult = {
  repositories: string[];
  scannedDirectories: number;
  truncated: boolean;
};

export async function findRepositoryDirectories(
  root: string,
  options: { maxDepth?: number; directoryBudget?: number } = {}
): Promise<ScanResult> {
  const maxDepth = Math.min(
    MAX_SCAN_DEPTH,
    Math.max(0, options.maxDepth ?? DEFAULT_SCAN_DEPTH)
  );
  const directoryBudget = Math.max(
    1,
    options.directoryBudget ?? DEFAULT_DIRECTORY_BUDGET
  );
  const repositories: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let scannedDirectories = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (scannedDirectories >= directoryBudget) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    if (current === undefined) break;
    scannedDirectories += 1;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    const gitEntry = entries.find(
      (entry) => entry.name === ".git" && !entry.isSymbolicLink()
    );
    if (gitEntry !== undefined && (gitEntry.isDirectory() || gitEntry.isFile())) {
      repositories.push(current.path);
      continue;
    }
    if (current.depth >= maxDepth) continue;
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        SKIP_DIRECTORIES.has(entry.name) ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }

  return { repositories, scannedDirectories, truncated };
}

export type RootCandidateSource =
  | "configured"
  | "requested"
  | "current_workspace"
  | "conventional";

export type RootCandidate = {
  path: string;
  source: RootCandidateSource;
};

async function existingDirectory(path: string): Promise<string | null> {
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

export async function rootCandidates(options: {
  requested?: readonly string[];
  includeConventional?: boolean;
  includeConfigured?: boolean;
  includeCurrentWorkspace?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
} = {}): Promise<RootCandidate[]> {
  const candidates: Array<{ path: string; source: RootCandidateSource }> = [];
  const env = options.env ?? process.env;
  for (const path of options.requested ?? []) {
    candidates.push({ path, source: "requested" });
  }
  const configured = env.PWRGIT_MCP_ROOTS;
  if (options.includeConfigured !== false && configured !== undefined) {
    for (const path of configured.split(delimiter).filter((entry) => entry.trim() !== "")) {
      candidates.push({ path, source: "configured" });
    }
  }

  if (options.includeCurrentWorkspace !== false) {
    const cwd = options.cwd ?? process.cwd();
    const currentRepo = await repositoryRootFor(cwd, options.runner).catch(() => null);
    if (currentRepo !== null) {
      candidates.push({ path: parentOfRepository(currentRepo), source: "current_workspace" });
    }
  }

  if (options.includeConventional !== false) {
    const home = homedir();
    for (const name of [
      "code",
      "Code",
      "dev",
      "Development",
      "git",
      "projects",
      "Projects",
      "repos",
      "Repositories",
      "src",
      "work",
      "workspace",
      "Workspaces"
    ]) {
      candidates.push({ path: join(home, name), source: "conventional" });
    }
  }

  const output: RootCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const path = await existingDirectory(resolve(candidate.path));
    if (path === null) continue;
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ path, source: candidate.source });
  }
  return output;
}

export type DiscoveredRoot = RootCandidate & {
  repositoryCount: number;
  scannedDirectories: number;
  truncated: boolean;
};

export async function discoverRepositoryRoots(options: {
  requested?: readonly string[];
  includeConventional?: boolean;
  maxDepth?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
} = {}): Promise<{
  roots: DiscoveredRoot[];
  limits: { maxDepth: number; maxDirectories: number; maxRoots: number };
}> {
  const maxDepth = Math.min(
    MAX_SCAN_DEPTH,
    Math.max(0, options.maxDepth ?? DEFAULT_SCAN_DEPTH)
  );
  const candidates = (
    await rootCandidates(options)
  ).slice(0, 32);
  let remainingBudget = MAX_TOTAL_DIRECTORY_BUDGET;
  const roots: DiscoveredRoot[] = [];
  for (const candidate of candidates) {
    if (remainingBudget <= 0) break;
    const scan = await findRepositoryDirectories(candidate.path, {
      maxDepth,
      directoryBudget: Math.min(DEFAULT_DIRECTORY_BUDGET, remainingBudget)
    });
    remainingBudget -= scan.scannedDirectories;
    roots.push({
      ...candidate,
      repositoryCount: scan.repositories.length,
      scannedDirectories: scan.scannedDirectories,
      truncated: scan.truncated
    });
  }
  return {
    roots,
    limits: {
      maxDepth,
      maxDirectories: MAX_TOTAL_DIRECTORY_BUDGET,
      maxRoots: 32
    }
  };
}

export type CheckoutMatch = {
  repositoryPath: string;
  matchedPath: string;
  remoteName: string;
  identity: RemoteIdentity;
};

async function repositoryPrimaryPath(
  path: string,
  runner?: CommandRunner
): Promise<string> {
  const result = await git(path, ["worktree", "list", "--porcelain", "-z"], runner);
  if (result.exitCode !== 0) return path;
  const primary = parseWorktreeList(result.stdout)[0]?.path ?? path;
  return realpath(primary).catch(() => primary);
}

async function matchRepository(
  path: string,
  target: RepositoryTarget,
  runner?: CommandRunner
): Promise<CheckoutMatch[]> {
  try {
    const remotes = await readConfiguredRemotes(path, runner);
    return remotes.flatMap((remote) =>
      targetMatchesRemote(target, remote)
        ? [
            {
              repositoryPath: path,
              matchedPath: path,
              remoteName: remote.name,
              identity: {
                provider: remote.provider,
                host: remote.host,
                path: remote.path
              }
            }
          ]
        : []
    );
  } catch {
    return [];
  }
}

export async function findRepositoryCheckouts(options: {
  repository: string;
  provider?: "github" | "gitlab";
  roots?: readonly string[];
  maxDepth?: number;
  maxResults?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
}): Promise<{
  target: RepositoryTarget;
  matches: CheckoutMatch[];
  scannedRoots: string[];
  scannedDirectories: number;
  inspectedRepositories: number;
  truncated: boolean;
}> {
  const target = parseRepositoryTarget(options.repository, options.provider);
  if (target === null) {
    throw new Error(
      "repository must be an owner/name, host/owner/name, or GitHub/GitLab remote URL"
    );
  }
  const candidates = await rootCandidates({
    ...(options.roots === undefined ? {} : { requested: options.roots }),
    includeConventional: options.roots === undefined,
    includeConfigured: options.roots === undefined,
    includeCurrentWorkspace: options.roots === undefined,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.runner === undefined ? {} : { runner: options.runner })
  });
  const maxResults = Math.min(20, Math.max(1, options.maxResults ?? 10));
  const maxDepth = Math.min(
    MAX_SCAN_DEPTH,
    Math.max(0, options.maxDepth ?? DEFAULT_SCAN_DEPTH)
  );
  const matches: CheckoutMatch[] = [];
  const seen = new Set<string>();
  let scannedDirectories = 0;
  let inspectedRepositories = 0;
  let truncated = false;
  const scannedRoots: string[] = [];

  for (const candidate of candidates.slice(0, 32)) {
    const remaining = MAX_TOTAL_DIRECTORY_BUDGET - scannedDirectories;
    if (remaining <= 0 || matches.length >= maxResults) {
      truncated = true;
      break;
    }
    scannedRoots.push(candidate.path);
    const scan = await findRepositoryDirectories(candidate.path, {
      maxDepth,
      directoryBudget: Math.min(DEFAULT_DIRECTORY_BUDGET, remaining)
    });
    scannedDirectories += scan.scannedDirectories;
    truncated ||= scan.truncated;
    for (const repositoryPath of scan.repositories) {
      if (inspectedRepositories >= MAX_REPOSITORIES_INSPECTED) {
        truncated = true;
        break;
      }
      inspectedRepositories += 1;
      const found = await matchRepository(repositoryPath, target, options.runner);
      for (const match of found) {
        const primary = await repositoryPrimaryPath(repositoryPath, options.runner);
        const key = `${primary}\0${match.identity.host}\0${match.identity.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({ ...match, repositoryPath: primary });
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
      }
      if (matches.length >= maxResults) break;
    }
    if (inspectedRepositories >= MAX_REPOSITORIES_INSPECTED) break;
  }

  return {
    target,
    matches,
    scannedRoots,
    scannedDirectories,
    inspectedRepositories,
    truncated
  };
}

export function containingDirectory(path: string): string {
  return dirname(path);
}
