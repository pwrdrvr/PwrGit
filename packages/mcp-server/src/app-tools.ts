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
  mcp.registerTool("pwrgit_app_repositories", {
    description: "Find repositories and worktrees known to PwrGit, their local paths, saved per-profile selection, pinned state and cached dirty/ahead/behind counts. For recently used repos use sort=recently_viewed, which ranks actual selections in PwrGit, not commit dates. lastViewedAt=null means no recorded visit; lastCommitAt is a separate Git activity signal. History from older versions imports when the profile window opens. Defaults to all authorized profiles. Requires repository.metadata.read.",
    inputSchema: { profileId: z.string().optional(), query: z.string().max(200).optional(),
      sort: z.enum(["recently_viewed", "name"]).default("recently_viewed"), limit: z.number().int().min(1).max(100).default(20) }, annotations: readOnly
  }, async input => {
    const state = await catalog();
    const query = input.query?.toLowerCase() ?? "";
    const repos = state.repositories.filter(repo => (!input.profileId || repo.profileId === input.profileId)
      && `${repo.name} ${repo.path} ${repo.worktrees.map(w => `${w.path} ${w.branch}`).join(" ")}`.toLowerCase().includes(query))
      .map(repo => ({ ...repo, lastViewedAt: repo.worktrees.map(w => w.lastViewedAt).filter((date): date is string => date !== null).sort().at(-1) ?? null }));
    repos.sort((a, b) => (input.sort === "recently_viewed" ? (b.lastViewedAt ?? "").localeCompare(a.lastViewedAt ?? "") : 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return result({ protocol: "pwrgit.app/v1", activeProfileId: state.activeProfileId, source: "PwrGit application index", total: repos.length,
      truncated: repos.length > input.limit, repositories: repos.slice(0, input.limit) });
  });
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
