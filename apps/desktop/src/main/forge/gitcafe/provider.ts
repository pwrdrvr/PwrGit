import type { PrSummary } from "@pwrgit/shared";
import { ForgeResponseError } from "../repo-provider";
import { forgeOrigin, type CliForgeProvider, type ForgeRepo } from "../types";
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
          const pr = parseCafePr(row, repo);
          const branch = pr.headRefName!;
          if (wanted.has(branch))
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
        const pr = parseCafePr(cafeResource(stdout), repo);
        if (pr.number !== number)
          throw new ForgeResponseError(
            "GitCafe returned a different pull request."
          );
        found.set(number, pr);
      }
      return found;
    }
  };
}
export const gitcafeProvider = createGitCafeProvider();

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
