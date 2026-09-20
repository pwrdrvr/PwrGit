import type {
  AgentInputFile,
  AgentInputManifest,
  AgentMessageStyle,
  RebaseCommitRef
} from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";

/**
 * Builds what a local agent is allowed to see: commit subjects and bodies,
 * and diffs cut to a line budget. Lockfiles, snapshots, binaries and
 * credential-shaped paths are left out entirely, and every file — sent or not —
 * is listed in the manifest the operator can open from the draft.
 *
 * Every Git call here is a read.
 */

/** Diff lines one request may carry. */
export const AGENT_DIFF_BUDGET_LINES = 2_000;
/** No single file may take more than this, so one big file cannot starve the rest. */
const PER_FILE_LINE_CAP = 400;
/** Recent subjects read to learn the repository's message style. */
const STYLE_SAMPLE = 20;
const MAX_BODY_CHARS = 1_000;

/** Every name here is matched against a lower-cased basename. */
const lowerSet = (names: string[]): Set<string> =>
  new Set(names.map((name) => name.toLowerCase()));

const LOCKFILES = lowerSet([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "Podfile.lock",
  "packages.lock.json"
]);

const NEVER_SEND_NAMES = lowerSet([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519"
]);
const NEVER_SEND_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];
/** `.env.example` and friends document variables; they are meant to be shared. */
const SHAREABLE_ENV = /^\.env\.(example|sample|template|dist)$/;

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Why a path is never sent, or null when it may be. Paths from Git are always
 *  forward-slash (see src/main/git/AGENTS.md). */
export function exclusionFor(
  path: string,
  binary: boolean
): Exclude<AgentInputFile["treatment"], "sent" | "cut"> | null {
  const name = baseName(path);
  // Every never-send test is case-insensitive: macOS and Windows resolve
  // `.ENV` and `ID_RSA` to the same file, and a guard that only catches one
  // spelling is not a guard.
  const lower = name.toLowerCase();
  const segments = path.toLowerCase().split("/");
  if (
    (/^\.env(\..+)?$/.test(lower) && !SHAREABLE_ENV.test(lower)) ||
    NEVER_SEND_NAMES.has(lower) ||
    NEVER_SEND_EXTENSIONS.some((ext) => lower.endsWith(ext)) ||
    segments.includes("secrets")
  ) {
    return "never_send";
  }
  if (binary) return "binary";
  if (LOCKFILES.has(lower) || lower.endsWith(".lock")) return "lockfile";
  if (lower.endsWith(".snap") || segments.includes("__snapshots__")) {
    return "snapshot";
  }
  return null;
}

type NumstatEntry = { path: string; added: number; removed: number; binary: boolean };

export function parseNumstat(stdout: string): NumstatEntry[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [added = "0", removed = "0", ...rest] = line.split("\t");
      const binary = added === "-" && removed === "-";
      return {
        path: rest.join("\t"),
        added: binary ? 0 : Number.parseInt(added, 10) || 0,
        removed: binary ? 0 : Number.parseInt(removed, 10) || 0,
        binary
      };
    })
    .filter((entry) => entry.path !== "");
}

const DIFF_HEADER = "diff --git ";

/**
 * The destination path of a `diff --git a/<x> b/<y>` line. A path may itself
 * contain " b/", so the halves are split where they agree — which is every
 * path here, since the diffs are taken with `--no-renames`. A rename, or a
 * path that cannot be split that way, falls back to the last candidate.
 */
export function destinationPath(line: string): string | null {
  if (!line.startsWith(DIFF_HEADER)) return null;
  const body = line.slice(DIFF_HEADER.length);
  if (!body.startsWith("a/")) return null;
  for (let at = body.indexOf(" b/"); at !== -1; at = body.indexOf(" b/", at + 1)) {
    if (body.slice(2, at) === body.slice(at + 3)) return body.slice(at + 3);
  }
  const last = body.lastIndexOf(" b/");
  return last === -1 ? null : body.slice(last + 3);
}

/** Split a multi-file patch into per-path chunks, keyed by the `b/` path. */
export function splitPatch(patch: string): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of patch.split("\n")) {
    const path = destinationPath(line);
    if (path !== null) {
      current = [line];
      byPath.set(path, current);
      continue;
    }
    current?.push(line);
  }
  return byPath;
}

type Budget = { used: number; limit: number };

type DiffUnit = {
  entries: NumstatEntry[];
  patch: (paths: string[]) => Promise<string>;
};

/** Apply exclusions and the budget to one unit (a commit, or the index). */
async function readUnit(
  unit: DiffUnit,
  budget: Budget,
  files: Map<string, AgentInputFile>
): Promise<string> {
  const sendable: NumstatEntry[] = [];
  for (const entry of unit.entries) {
    const excluded = exclusionFor(entry.path, entry.binary);
    const record = files.get(entry.path) ?? {
      path: entry.path,
      added: 0,
      removed: 0,
      treatment: excluded ?? "sent",
      sentLines: 0,
      totalLines: 0
    };
    record.added += entry.added;
    record.removed += entry.removed;
    files.set(entry.path, record);
    if (excluded === null) sendable.push(entry);
  }
  if (sendable.length === 0) return "";
  if (budget.used >= budget.limit) {
    // The budget is spent, so every line of this patch would be dropped —
    // don't read it. The manifest says `cut` with nothing sent, which is
    // exactly what happened to these files.
    for (const entry of sendable) files.get(entry.path)!.treatment = "cut";
    return "";
  }

  const chunks = splitPatch(await unit.patch(sendable.map((entry) => entry.path)));
  const out: string[] = [];
  for (const entry of sendable) {
    const record = files.get(entry.path)!;
    const lines = chunks.get(entry.path) ?? [];
    record.totalLines += lines.length;
    const room = Math.max(0, Math.min(PER_FILE_LINE_CAP, budget.limit - budget.used));
    const kept = lines.slice(0, room);
    record.sentLines += kept.length;
    budget.used += kept.length;
    if (kept.length < lines.length) record.treatment = "cut";
    if (kept.length > 0) {
      out.push(...kept);
      if (kept.length < lines.length) {
        out.push(`[… ${lines.length - kept.length} more lines of ${entry.path} not sent]`);
      }
    }
  }
  return out.join("\n");
}

function manifest(
  source: AgentInputManifest["source"],
  commitCount: number,
  files: Map<string, AgentInputFile>,
  budget: Budget,
  styleSubjects: number
): AgentInputManifest {
  return {
    source,
    commitCount,
    files: [...files.values()],
    budget: { used: budget.used, limit: budget.limit },
    styleSubjects
  };
}

async function readLines(git: GitExec, cwd: string, args: string[]): Promise<string | null> {
  const raw = await git(args, cwd);
  if (!raw.ok || raw.value.exitCode !== 0) return null;
  return raw.value.stdout;
}

const QUOTE_PATH = ["-c", "core.quotePath=false"];

/** Learn whether the repository writes conventional commits from its recent
 *  subjects. Returns the subjects too: they are sent as style examples. */
export async function readMessageStyle(
  git: GitExec,
  cwd: string,
  rev: string
): Promise<{ style: AgentMessageStyle; subjects: string[] }> {
  const raw = await readLines(git, cwd, ["log", "-n", String(STYLE_SAMPLE), "--format=%s", rev]);
  const subjects = (raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const matched = subjects.filter((subject) =>
    /^[a-z]+(\([^)]*\))?!?: \S/.test(subject)
  ).length;
  return {
    style: {
      convention:
        subjects.length >= 5 && matched / subjects.length >= 0.6 ? "conventional" : "plain",
      matched,
      sampled: subjects.length
    },
    subjects: subjects.map((subject) => subject.slice(0, 200))
  };
}

export type CommitInput = {
  hash: string;
  subject: string;
  body: string;
  diff: string;
};

export type CommitsInput = {
  commits: CommitInput[];
  styleSubjects: string[];
  style: AgentMessageStyle;
  manifest: AgentInputManifest;
};

/**
 * Subjects, bodies and budgeted diffs for `commits` (newest-first in, oldest
 * first out), plus the style sample from before the oldest one.
 */
export async function collectCommitsInput(
  git: GitExec,
  cwd: string,
  commits: RebaseCommitRef[],
  budgetLines: number = AGENT_DIFF_BUDGET_LINES
): Promise<CommitsInput | null> {
  const budget: Budget = { used: 0, limit: budgetLines };
  const files = new Map<string, AgentInputFile>();
  const out: CommitInput[] = [];
  for (const commit of [...commits].reverse()) {
    const body = await readLines(git, cwd, ["log", "-1", "--format=%b", commit.hash]);
    const numstat = await readLines(git, cwd, [
      ...QUOTE_PATH,
      "show",
      "--format=",
      "--numstat",
      "--no-renames",
      commit.hash
    ]);
    if (body === null || numstat === null) return null;
    const diff = await readUnit(
      {
        entries: parseNumstat(numstat),
        patch: async (paths) =>
          (await readLines(git, cwd, [
            ...QUOTE_PATH,
            "show",
            "--format=",
            "--patch",
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            "-U3",
            commit.hash,
            "--",
            ...paths
          ])) ?? ""
      },
      budget,
      files
    );
    out.push({
      hash: commit.hash,
      subject: commit.subject,
      body: body.trim().slice(0, MAX_BODY_CHARS),
      diff
    });
  }
  const oldest = commits[commits.length - 1]?.hash;
  const { style, subjects } = await readMessageStyle(
    git,
    cwd,
    oldest === undefined ? "HEAD" : `${oldest}^`
  );
  return {
    commits: out,
    styleSubjects: subjects,
    style,
    manifest: manifest("commits", commits.length, files, budget, subjects.length)
  };
}

export type StagedInput = {
  diff: string;
  styleSubjects: string[];
  style: AgentMessageStyle;
  manifest: AgentInputManifest;
};

/** The staged changes only — never the working tree. */
export async function collectStagedInput(
  git: GitExec,
  cwd: string,
  budgetLines: number = AGENT_DIFF_BUDGET_LINES
): Promise<StagedInput | null> {
  const budget: Budget = { used: 0, limit: budgetLines };
  const files = new Map<string, AgentInputFile>();
  const numstat = await readLines(git, cwd, [
    ...QUOTE_PATH,
    "diff",
    "--cached",
    "--numstat",
    "--no-renames"
  ]);
  if (numstat === null) return null;
  const diff = await readUnit(
    {
      entries: parseNumstat(numstat),
      patch: async (paths) =>
        (await readLines(git, cwd, [
          ...QUOTE_PATH,
          "diff",
          "--cached",
          "--patch",
          "--no-color",
          "--no-ext-diff",
          "--no-renames",
          "-U3",
          "--",
          ...paths
        ])) ?? ""
    },
    budget,
    files
  );
  const { style, subjects } = await readMessageStyle(git, cwd, "HEAD");
  return {
    diff,
    styleSubjects: subjects,
    style,
    manifest: manifest("staged", 0, files, budget, subjects.length)
  };
}
