import type { OpenChangeRequest, PrSummary } from "@pwrgit/shared";
import { ForgeResponseError } from "../repo-provider";
import {
  forgeOrigin,
  OPEN_PR_LIST_CAP,
  UNAVAILABLE_FORK,
  type CliForgeProvider,
  type ForgeRepo
} from "../types";
import {
  cafeHostArgs,
  cafePage,
  cafeResource,
  object,
  runCafe,
  type CafeRunner
} from "./cafe-cli";

export function parseCafePr(value: unknown, repo: ForgeRepo): PrSummary {
  const row = object(value);
  if (
    !Number.isSafeInteger(row.number) ||
    Number(row.number) < 1 ||
    typeof row.title !== "string" ||
    !["open", "closed", "merged", "draft"].includes(String(row.state)) ||
    typeof row.sourceBranch !== "string" ||
    typeof row.targetBranch !== "string" ||
    typeof row.draft !== "boolean"
  ) {
    throw new ForgeResponseError("GitCafe returned an invalid pull request.");
  }
  const summary: PrSummary = {
    number: Number(row.number),
    title: row.title,
    url: `${forgeOrigin(repo)}/${repo.path}/pulls/${row.number}`,
    state:
      row.state === "merged"
        ? "merged"
        : row.state === "closed"
          ? "closed"
          : "open",
    isDraft: row.draft || row.state === "draft",
    headRefName: row.sourceBranch,
    baseRefName: row.targetBranch,
    forge: repo.kind,
    host: repo.host,
    repoPath: repo.path
  };
  for (const key of ["createdAt", "mergedAt", "closedAt"] as const) {
    if (typeof row[key] === "string") {
      const time = Date.parse(row[key]);
      if (Number.isFinite(time)) summary[key] = time;
    }
  }
  return summary;
}

export function createGitCafeProvider(
  run: CafeRunner = runCafe
): CliForgeProvider {
  return {
    kind: "gitcafe",
    authentication: "cli",
    async fetchPrsForBranches(repo, branches) {
      if (branches.length === 0) return new Map();
      // Walk every state and page before writing negative cache entries. A page
      // failure or a safety cap is not evidence that a branch has no PR.
      const candidates = new Map<string, Record<string, unknown>[]>();
      const wanted = new Set(branches);
      const seen = new Set<string>();
      let cursor: string | null = null;
      let complete = false;
      for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
        const page = cafePage(
          await run([
            "pr",
            "list",
            "--repo",
            repo.path,
            "--limit",
            "200",
            "--json",
            ...cafeHostArgs(repo.host, repo.port),
            ...(cursor === null ? [] : ["--cursor", cursor])
          ])
        );
        for (const item of page.items) {
          const row = object(item);
          // Only the branch is needed to decide whether this row is wanted, and
          // it is the field `parseCafePr` would read anyway. Validating the
          // whole summary here made one malformed PR anywhere in the repository
          // throw away the lookup for every OTHER branch too — and paid for a
          // PrSummary plus three Date.parse calls on up to 10,000 rows we
          // discard. Rows that survive the filter are still fully parsed below.
          const branch = row.sourceBranch;
          if (typeof branch === "string" && wanted.has(branch))
            candidates.set(branch, [...(candidates.get(branch) ?? []), row]);
        }
        cursor = page.nextCursor;
        if (cursor === null) {
          complete = true;
          break;
        }
        if (seen.has(cursor))
          throw new ForgeResponseError("GitCafe repeated a pagination cursor.");
        seen.add(cursor);
      }
      if (!complete)
        throw new ForgeResponseError(
          "GitCafe pull request listing exceeded the page limit."
        );
      const result = new Map<string, PrSummary | null>();
      for (const branch of wanted) {
        const rows = (candidates.get(branch) ?? []).sort(
          (a, b) => Number(b.number) - Number(a.number)
        );
        let match: PrSummary | null = null;
        for (let row of rows) {
          let belongs = sourceMatches(row, repo);
          // 0.5.0 list responses omit cross-fork provenance. The detail command
          // provides it. A merged PR is used for pruning, so never infer this.
          if (belongs === undefined) {
            let stdout: string;
            try {
              stdout = await run([
                "pr",
                "view",
                String(row.number),
                "--repo",
                repo.path,
                "--json",
                ...cafeHostArgs(repo.host, repo.port)
              ]);
            } catch (error) {
              if (result.size === 0) throw error;
              return result;
            }
            const detail = cafeResource(stdout);
            if (detail.number !== row.number || detail.sourceBranch !== branch)
              throw new ForgeResponseError(
                "GitCafe returned a different pull request."
              );
            row = detail;
            belongs = sourceMatches(row, repo);
          }
          if (belongs === undefined)
            throw new ForgeResponseError(
              "GitCafe did not identify the pull request's source repository."
            );
          if (belongs) {
            match = parseCafePr(row, repo);
            break;
          }
        }
        result.set(branch, match);
      }
      return result;
    },
    // No documented exact-commit association command. Omit keys (unknown),
    // never report null (authoritatively no PR) or guess from a branch name.
    async fetchPrsForCommits() {
      return new Map();
    },
    async fetchPrsByNumbers(repo, numbers) {
      const found = new Map<number, PrSummary | null>();
      for (const number of new Set(numbers)) {
        let stdout: string;
        try {
          stdout = await run([
            "pr",
            "view",
            String(number),
            "--repo",
            repo.path,
            "--json",
            ...cafeHostArgs(repo.host, repo.port)
          ]);
        } catch (error) {
          if (found.size === 0) throw error;
          break;
        }
        const row = cafeResource(stdout);
        // A fork's carries `headRepoPath`: a lookup locates the head by it.
        const pr: OpenChangeRequest = { ...parseCafePr(row, repo) };
        const fork = cafeForkPath(row, repo);
        if (fork !== undefined) pr.headRepoPath = fork;
        if (pr.number !== number)
          throw new ForgeResponseError(
            "GitCafe returned a different pull request."
          );
        found.set(number, pr);
      }
      return found;
    },
    async fetchOpenPrs(repo) {
      // cafe 0.5.0 documents no state filter on `pr list`, so the open set is
      // the same every-state walk the branch lookup makes, filtered here.
      const open: OpenChangeRequest[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      let complete = false;
      for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
        const page = cafePage(
          await run([
            "pr",
            "list",
            "--repo",
            repo.path,
            "--limit",
            "200",
            "--json",
            ...cafeHostArgs(repo.host, repo.port),
            ...(cursor === null ? [] : ["--cursor", cursor])
          ])
        );
        for (const item of page.items) {
          const row = object(item);
          if (row.state !== "open" && row.state !== "draft") continue;
          open.push(openCafePr(row, repo));
        }
        cursor = page.nextCursor;
        if (cursor === null) {
          complete = true;
          break;
        }
        if (seen.has(cursor))
          throw new ForgeResponseError("GitCafe repeated a pagination cursor.");
        seen.add(cursor);
      }
      open.sort(
        (a, b) =>
          (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0) ||
          b.number - a.number
      );
      return {
        items: open.slice(0, OPEN_PR_LIST_CAP),
        truncated: !complete || open.length > OPEN_PR_LIST_CAP
      };
    }
  };
}
export const gitcafeProvider = createGitCafeProvider();

/**
 * A list row as an open change request. Provenance a list row does not carry
 * stays unknown and reads as the base repository — the only one whose branches
 * a checkout of it could see — and no per-row detail read is spent learning
 * it: unlike pruning, nothing here is authorized by a same-named branch.
 */
function openCafePr(
  row: Record<string, unknown>,
  repo: ForgeRepo
): OpenChangeRequest {
  const summary: OpenChangeRequest = { ...parseCafePr(row, repo) };
  const fork = cafeForkPath(row, repo);
  if (fork !== undefined) summary.headRepoPath = fork;
  const author = row.author;
  const login =
    typeof author === "string"
      ? author
      : typeof author === "object" && author !== null
        ? (author as Record<string, unknown>).login ??
          (author as Record<string, unknown>).username
        : undefined;
  if (typeof login === "string" && login.trim() !== "") {
    summary.author = login.trim();
  }
  if (typeof row.updatedAt === "string") {
    const time = Date.parse(row.updatedAt);
    if (Number.isFinite(time)) summary.updatedAt = time;
  }
  return summary;
}

/**
 * A fork's source repository, or undefined for the base repository — and for
 * a row that does not say, which reads as the base like everywhere else here.
 * A row that reports only `crossFork` names no repository at all.
 */
function cafeForkPath(
  row: Record<string, unknown>,
  repo: ForgeRepo
): string | undefined {
  if (sourceMatches(row, repo) !== false) return undefined;
  const source = row.sourceRepo ?? row.headRepo;
  if (source === undefined || source === null) return UNAVAILABLE_FORK;
  const head = object(source);
  return `${String(head.owner)}/${String(head.name)}`;
}

/** Undefined means the list needs a detail read before it can prove ownership. */
function sourceMatches(
  row: Record<string, unknown>,
  repo: ForgeRepo
): boolean | undefined {
  const source = row.sourceRepo ?? row.headRepo;
  if (source !== undefined && source !== null) {
    const head = object(source);
    if (typeof head.owner !== "string" || typeof head.name !== "string")
      throw new ForgeResponseError(
        "GitCafe returned an invalid PR source repository."
      );
    return (
      `${head.owner}/${head.name}`.toLowerCase() === repo.path.toLowerCase()
    );
  }
  const crossFork = row.isCrossFork ?? row.crossFork;
  return typeof crossFork === "boolean" ? !crossFork : undefined;
}
