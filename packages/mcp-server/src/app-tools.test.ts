import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { FixedMcpAuthorizer, fullAccessAuthorization, McpPolicyStore, PolicyFileAuthorizer, MCP_AGENT_CAPABILITIES } from "./access-policy.js";
import { createPwrGitMcpServer } from "./server.js";
import type { AppBackend } from "./app-tools.js";

it("uses app history, filters scope, dispatches app actions and enforces OAuth grants/revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-app-tools-"));
  const inside = join(root, "inside"); const outside = join(root, "outside");
  mkdirSync(inside); mkdirSync(outside);
  const policy = new McpPolicyStore(join(root, "policy.json")); policy.initialize();
  const role = policy.createRole({ name: "App control", description: "", permissions: [...MCP_AGENT_CAPABILITIES], repositoryRoots: [inside] });
  const session = policy.createSession("test", role.id);
  const repo = (id: string, path: string, lastViewedAt: string | null) => ({ id, profileId: "profile", name: id, path, pinned: false,
    worktrees: [{ id: id + "-wt", path, branch: "main", selected: false, pinned: false, isPrimary: true, missing: false, lastViewedAt, lastCommitAt: "2026-09-09T00:00:00.000Z", dirty: 0, ahead: 0, behind: 0 }] });
  const recentRepo = repo("recent", inside, "2026-09-08T00:00:00.000Z");
  const baseWorktree = recentRepo.worktrees[0]!;
  recentRepo.worktrees.push(
    { ...baseWorktree, id: "linked-one", branch: "topic", pinned: true, isPrimary: false },
    { ...baseWorktree, id: "linked-two", branch: "topic", pinned: true, isPrimary: false, missing: true },
    { ...baseWorktree, id: "detached", branch: "detached@abc1234", pinned: true, isPrimary: false },
    { ...baseWorktree, id: "out-of-scope", path: outside, branch: "private", pinned: true, isPrimary: false }
  );
  const backend: AppBackend = { catalog: () => ({ activeProfileId: "profile", profiles: [{ id: "profile", name: "Personal", roots: [inside, outside] }],
    repositories: [repo("older", inside, "2026-09-01T00:00:00.000Z"), recentRepo, repo("hidden", outside, "2026-09-09T00:00:00.000Z"), repo("never", inside, null)] }), open: vi.fn(), refresh: vi.fn() };
  const server = await createPwrGitMcpServer({ appBackend: backend, authorizer: new PolicyFileAuthorizer(policy.filePath, session.token) });
  const client = new Client({ name: "app-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.mcp.connect(serverTransport); await client.connect(clientTransport);
    const listed = await client.callTool({ name: "pwrgit_app_repositories", arguments: {} });
    expect(listed.isError).not.toBe(true);
    const data = listed.structuredContent as { repositories: Array<{ id: string }>; total: number };
    expect(data.repositories.map(repo => repo.id)).toEqual(["recent", "older", "never"]);
    expect(JSON.stringify(listed)).not.toContain(outside);
    expect(listed.structuredContent).toMatchObject({ repositories: expect.arrayContaining([
      expect.objectContaining({ id: "recent", pinned: false, worktreeCount: 4, linkedWorktreeCount: 3,
        pinnedWorktreeCount: 3, pinnedWorktreeBranchCount: 1 }),
      expect.objectContaining({ id: "older", worktreeCount: 1, linkedWorktreeCount: 0, pinnedWorktreeCount: 0, pinnedWorktreeBranchCount: 0 })
    ]) });
    expect(listed.structuredContent).toMatchObject({ ordering: { by: "lastViewedAt", direction: "descending", unknownVisits: "last" },
      history: { repositoriesWithVisits: 2, repositoriesWithoutVisits: 1, coverage: "partial" } });
    const recent = await client.callTool({ name: "pwrgit_app_recent_repositories", arguments: { limit: 1 } });
    expect(recent.structuredContent).toMatchObject({ total: 2, truncated: true,
      ordering: { by: "lastViewedAt", direction: "descending", unknownVisits: "excluded" },
      repositories: [{ id: "recent", lastViewedAt: "2026-09-08T00:00:00.000Z" }] });
    expect(JSON.stringify(recent)).not.toContain(outside);
    const unknown = await client.callTool({ name: "pwrgit_app_repositories", arguments: { query: "never" } });
    expect(unknown.structuredContent).toMatchObject({ history: { coverage: "none", repositoriesWithVisits: 0 }, repositories: [{ lastViewedAt: null }] });
    const originalCatalog = backend.catalog;
    const originalState = await backend.catalog();
    backend.catalog = () => ({ ...originalState, repositories: [repo("never", inside, null)] });
    const emptyHistory = await client.callTool({ name: "pwrgit_app_recent_repositories", arguments: {} });
    expect(emptyHistory.structuredContent).toMatchObject({ total: 0, repositories: [], history: { coverage: "none", repositoriesWithoutVisits: 1 } });
    backend.catalog = originalCatalog;
    const profiles = await client.callTool({ name: "pwrgit_app_profiles", arguments: {} });
    expect(JSON.stringify(profiles)).not.toContain(outside);
    expect((await client.callTool({ name: "pwrgit_app_open", arguments: { repoId: "recent", worktreeId: "recent-wt" } })).isError).not.toBe(true);
    expect(backend.open).toHaveBeenCalledTimes(1);
    expect((await client.callTool({ name: "pwrgit_app_open", arguments: { repoId: "hidden" } })).isError).toBe(true);
    expect((await client.callTool({ name: "pwrgit_app_refresh", arguments: { repoId: "recent" } })).isError).not.toBe(true);
    expect(backend.refresh).toHaveBeenCalledTimes(1);
    policy.updateRole(role.id, { permissions: ["repository.metadata.read"] });
    expect((await client.callTool({ name: "pwrgit_app_open", arguments: { repoId: "recent" } })).isError).toBe(true);
    expect(backend.open).toHaveBeenCalledTimes(1);
    policy.revokeSession(session.session.id);
    expect((await client.callTool({ name: "pwrgit_app_repositories", arguments: {} })).isError).toBe(true);
  } finally { await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); }
});

it("globally ranks mixed-profile visits before limiting and honors an explicit profile filter", async () => {
  const repo = (id: string, profileId: string, day: number) => ({ id, profileId, name: id, path: `/fixture/${id}`, pinned: false,
    worktrees: [{ id: `${id}-wt`, path: `/fixture/${id}`, branch: "main", selected: false, pinned: false, isPrimary: true, missing: false,
      lastViewedAt: `2026-09-0${day}T00:00:00.000Z`, lastCommitAt: null, dirty: 0, ahead: 0, behind: 0 }] });
  const backend: AppBackend = { catalog: () => ({ activeProfileId: "first",
    profiles: [{ id: "first", name: "First", roots: [] }, { id: "second", name: "Second", roots: [] }],
    repositories: [repo("first-old", "first", 1), repo("first-new", "first", 3), repo("second-old", "second", 2), repo("second-new", "second", 4)]
  }), open: vi.fn(), refresh: vi.fn() };
  const server = await createPwrGitMcpServer({ appBackend: backend, authorizer: new FixedMcpAuthorizer(fullAccessAuthorization()) });
  const client = new Client({ name: "mixed-profiles", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.mcp.connect(serverTransport); await client.connect(clientTransport);
    for (const tool of ["pwrgit_app_repositories", "pwrgit_app_recent_repositories"]) {
      const all = await client.callTool({ name: tool, arguments: {} });
      const data = all.structuredContent as { repositories: Array<{ id: string }> };
      expect(data.repositories.map(repo => repo.id)).toEqual(["second-new", "first-new", "second-old", "first-old"]);
      const limited = await client.callTool({ name: tool, arguments: { limit: 2 } });
      expect(limited.structuredContent).toMatchObject({ total: 4, truncated: true, profileCoverage: [
        { profileId: "first", matchingRepositories: 2, repositoriesWithVisits: 2, returnedRepositories: 1 },
        { profileId: "second", matchingRepositories: 2, repositoriesWithVisits: 2, returnedRepositories: 1 }
      ], repositories: [{ id: "second-new", profileName: "Second" }, { id: "first-new", profileName: "First" }] });
      const filtered = await client.callTool({ name: tool, arguments: { profileId: "second" } });
      expect(filtered.structuredContent).toMatchObject({ total: 2, truncated: false, profileCoverage: [{ profileId: "second", returnedRepositories: 2 }],
        repositories: [{ id: "second-new" }, { id: "second-old" }] });
    }
  } finally { await client.close(); await server.close(); }
});
