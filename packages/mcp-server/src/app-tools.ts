import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpAccessError, type McpAuthorizer } from "./access-policy.js";

export type AppWorktree = {
  id: string; path: string; branch: string; selected: boolean; lastViewedAt: string | null;
  lastCommitAt: string | null; dirty: number; ahead: number; behind: number;
};
export type AppRepository = {
  id: string; profileId: string; name: string; path: string; pinned: boolean; worktrees: AppWorktree[];
};
export type AppCatalog = {
  activeProfileId: string | null;
  profiles: Array<{ id: string; name: string; roots: string[] }>;
  repositories: AppRepository[];
};
/** App-owned state and explicit actions; never a generic command-bus proxy. */
export type AppBackend = {
  catalog(): AppCatalog | Promise<AppCatalog>;
  open(repo: AppRepository, worktreeId?: string): Promise<void>;
  refresh(repo: AppRepository): Promise<void>;
};

export function registerAppTools(mcp: McpServer, backend: AppBackend, authorizer: McpAuthorizer) {
  const permitted = async (path: string) => {
    try { await authorizer.authorize({ repositoryPaths: [path] }); return true; }
    catch (error) {
      if (error instanceof McpAccessError && error.code === "repository_outside_scope") return false;
      throw error;
    }
  };
  const catalog = async () => {
    const authorization = await authorizer.authorize({ capabilities: ["repository.metadata.read"] });
    const source = await backend.catalog();
    const repositories: AppRepository[] = [];
    for (const repo of source.repositories) {
      if (!await permitted(repo.path)) continue;
      const worktrees: AppWorktree[] = [];
      for (const worktree of repo.worktrees) if (await permitted(worktree.path)) worktrees.push(worktree);
      repositories.push({ ...repo, worktrees });
    }
    const profiles: AppCatalog["profiles"] = [];
    for (const profile of source.profiles) {
      const roots: string[] = [];
      for (const root of profile.roots) if (await permitted(root)) roots.push(root);
      if (authorization.repositoryRoots === null || roots.length || repositories.some(repo => repo.profileId === profile.id)) profiles.push({ ...profile, roots });
    }
    await authorizer.authorize({ capabilities: ["repository.metadata.read"], repositoryPaths: [...repositories.flatMap(repo => [repo.path, ...repo.worktrees.map(w => w.path)]), ...profiles.flatMap(profile => profile.roots)] });
    return { activeProfileId: profiles.some(profile => profile.id === source.activeProfileId) ? source.activeProfileId : null, profiles, repositories };
  };
  const result = (value: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  mcp.registerTool("pwrgit_app_profiles", {
    description: "Read PwrGit's profiles, configured repository roots, active profile and indexed repository counts. Uses the running app, not a filesystem scan. Requires repository.metadata.read.",
    inputSchema: {}, annotations: readOnly
  }, async () => {
    await authorizer.authorize({ capabilities: ["repository.roots.read"] });
    const state = await catalog();
    return result({ protocol: "pwrgit.app/v1", activeProfileId: state.activeProfileId,
      profiles: state.profiles.map(profile => ({ ...profile, repositoryCount: state.repositories.filter(repo => repo.profileId === profile.id).length })) });
  });
  const queryRepositories = async (input: { profileId?: string | undefined; query?: string | undefined; sort: "recently_viewed" | "name"; limit: number }, recentOnly = false) => {
    const state = await catalog();
    const query = input.query?.toLowerCase() ?? "";
    const matching = state.repositories.filter(repo => (!input.profileId || repo.profileId === input.profileId)
      && `${repo.name} ${repo.path} ${repo.worktrees.map(w => `${w.path} ${w.branch}`).join(" ")}`.toLowerCase().includes(query))
      .map(repo => ({ ...repo, lastViewedAt: repo.worktrees.map(w => w.lastViewedAt).filter((date): date is string => date !== null).sort().at(-1) ?? null }));
    const withHistory = matching.filter(repo => repo.lastViewedAt !== null).length;
    const repos = recentOnly ? matching.filter(repo => repo.lastViewedAt !== null) : matching;
    repos.sort((a, b) => (input.sort === "recently_viewed" ? (b.lastViewedAt ?? "").localeCompare(a.lastViewedAt ?? "") : 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return result({ protocol: "pwrgit.app/v1", activeProfileId: state.activeProfileId, source: "PwrGit application index", total: repos.length,
      ordering: { by: input.sort === "recently_viewed" ? "lastViewedAt" : "name", direction: input.sort === "recently_viewed" ? "descending" : "ascending", ties: "name then id", unknownVisits: recentOnly ? "excluded" : "last" },
      history: { meaning: "Time a worktree was selected in PwrGit, not its last commit or filesystem modification time.",
        repositoriesWithVisits: withHistory, repositoriesWithoutVisits: matching.length - withHistory,
        coverage: matching.length === 0 ? "no_repositories" : withHistory === 0 ? "none" : withHistory === matching.length ? "complete" : "partial",
        importNote: "Older sidebar history imports when its profile window selects a worktree. Unrecorded usage cannot be ranked." },
      truncated: repos.length > input.limit, repositories: repos.slice(0, input.limit) });
  };
  mcp.registerTool("pwrgit_app_repositories", {
    description: "Find repositories and worktrees known to PwrGit, their local paths, saved per-profile selection, pinned state and cached dirty/ahead/behind counts. Defaults to lastViewedAt descending across all authorized profiles; unvisited repositories sort last. For strictly recently used repositories call pwrgit_app_recent_repositories. lastCommitAt is a separate Git activity signal. Requires repository.metadata.read.",
    inputSchema: { profileId: z.string().optional(), query: z.string().max(200).optional(),
      sort: z.enum(["recently_viewed", "name"]).default("recently_viewed"), limit: z.number().int().min(1).max(100).default(20) }, annotations: readOnly
  }, input => queryRepositories(input));
  mcp.registerTool("pwrgit_app_recent_repositories", {
    description: "Answer which repositories the user most recently used in PwrGit and where they are. Returns only repositories with recorded PwrGit visits, newest first, with explicit lastViewedAt timestamps, local paths and history coverage. Defaults to all authorized profiles. Empty results mean no recorded visits, not that no repositories exist. Use pwrgit_app_repositories for the full catalog. Requires repository.metadata.read.",
    inputSchema: { profileId: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }, annotations: readOnly
  }, input => queryRepositories({ ...input, sort: "recently_viewed" }, true));
  for (const action of ["open", "refresh"] as const) {
    mcp.registerTool(`pwrgit_app_${action}`, {
      description: action === "open"
        ? "Open or focus a known repository/worktree in its PwrGit profile window. Get IDs from pwrgit_app_repositories. Requires app.navigate and repository.metadata.read; does not modify Git files."
        : "Refresh a known repository through PwrGit's indexer and worktree status service, discovering externally added worktrees and updating the UI. Does not fetch, commit, or modify Git files. Requires repository.metadata.read.",
      inputSchema: { repoId: z.string(), ...(action === "open" ? { worktreeId: z.string().optional() } : {}) },
      annotations: { ...readOnly, readOnlyHint: false }
    }, async input => {
      await authorizer.authorize({ capabilities: action === "open" ? ["repository.metadata.read", "app.navigate"] : ["repository.metadata.read"] });
      const state = await catalog();
      const repo = state.repositories.find(repo => repo.id === input.repoId);
      if (!repo) throw new Error("Repository unavailable or outside the Session's scope.");
      const worktreeId = "worktreeId" in input ? input.worktreeId as string | undefined : undefined;
      if (worktreeId && !repo.worktrees.some(w => w.id === worktreeId)) throw new Error("Worktree unavailable or outside the Session's scope.");
      await authorizer.authorize({ capabilities: action === "open" ? ["app.navigate"] : ["repository.metadata.read"], repositoryPaths: [repo.path, ...repo.worktrees.filter(w => !worktreeId || w.id === worktreeId).map(w => w.path)] });
      if (action === "open") await backend.open(repo, worktreeId);
      else await backend.refresh(repo);
      return result({ action, repoId: repo.id, completed: true });
    });
  }
}
