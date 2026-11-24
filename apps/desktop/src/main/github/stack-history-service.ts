import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { GitHubStack, Repo } from "@pwrgit/shared";
import { githubProvider } from "../forge/github/provider";
import type { ResolvedForge } from "../forge/providers";
import { githubOwnerAndName } from "../forge/resolve";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { limitConcurrency } from "../util/map-limit";
import { GITHUB_DOT_COM } from "./pr-client";
import { fetchGitHubStacks, StackHistoryResponseError, type GitHubStackHistory } from "./stack-client";

const HISTORY_TTL_MS = 10 * 60_000;
const INITIAL_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

type HistoryRepo = Pick<Repo, "id" | "profileId" | "path">;
type HistoryScope = { repoId: string; profileId: string };
type ForgeRemote = { key: string; name: string; forge: ResolvedForge };
export type ScopedGitHubStack = { scope: string; remote: string; stack: GitHubStack };

type RemoteHistory = {
  verified?: { auth: string; at: number; history: GitHubStackHistory };
  failure?: { at: number; backoff: number; delay: number };
  pending?: AbortController;
};
type RepoHistory = { profileId: string; path: string; remotes: Map<string, RemoteHistory> };

/** Stack reads use the last complete history while its own refresh runs. */
export class StackHistoryService {
  private readonly repos = new Map<string, RepoHistory>();
  // REST limits follow the token across checkouts and profiles. Only the
  // deadline is shared. Catalogs and validators stay in their repo cache.
  private readonly cooldownUntil = new Map<string, number>();
  private readonly refreshRemote = limitConcurrency(this.fetchRemote.bind(this), 2);

  constructor(
    private readonly db: DB,
    private readonly resolveRemotes: (path: string) => Promise<readonly ForgeRemote[] | null>,
    private readonly changed: (scope: HistoryScope) => void,
    private readonly isEnabled: (host: string) => boolean,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async list(repo: HistoryRepo): Promise<ScopedGitHubStack[]> {
    if (!this.owns(repo)) return [];
    let state = this.repos.get(repo.id);
    if (state?.profileId !== repo.profileId || state.path !== repo.path) {
      if (state) this.forget(repo.id, state);
      state = { profileId: repo.profileId, path: repo.path, remotes: new Map() };
      this.repos.set(repo.id, state);
    }
    const remotes = await this.resolveRemotes(repo.path);
    if (remotes === null || this.repos.get(repo.id) !== state || !this.owns(repo)) return [];
    const supported = remotes.filter(({ forge: { provider, repo } }) =>
      provider === githubProvider && repo.host.toLowerCase() === GITHUB_DOT_COM && repo.port === undefined);
    const keys = new Set(supported.map(remote => remote.key));
    for (const [key, cached] of state.remotes) {
      if (keys.has(key)) continue;
      cached.pending?.abort();
      state.remotes.delete(key);
    }

    const stacks: ScopedGitHubStack[] = [];
    for (const remote of supported) {
      const parts = githubOwnerAndName(remote.forge.repo);
      if (parts === null) continue;
      let cached = state.remotes.get(remote.key);
      if (!cached) {
        cached = {};
        state.remotes.set(remote.key, cached);
      }
      for (const stack of cached.verified?.history.stacks ?? []) {
        stacks.push({ scope: remote.key, remote: remote.name, stack });
      }
      const now = this.now();
      if (cached.pending || (cached.failure
        ? now - cached.failure.at < cached.failure.delay
        : cached.verified && now - cached.verified.at < HISTORY_TTL_MS)) continue;
      const controller = new AbortController();
      cached.pending = controller;
      void this.refreshRemote(repo, parts, cached, controller)
        .catch(cause => logMain("warn", "pr", `stack history refresh failed for ${repo.id}`, cause))
        .finally(() => { delete cached.pending; });
    }
    return stacks;
  }

  forgetProfile(profileId: string): void {
    for (const [id, state] of this.repos) {
      if (state.profileId === profileId) this.forget(id, state);
    }
  }

  forgetRepo(repoId: string): void {
    const state = this.repos.get(repoId);
    if (state) this.forget(repoId, state);
  }

  private forget(id: string, state: RepoHistory): void {
    this.repos.delete(id);
    for (const remote of state.remotes.values()) remote.pending?.abort();
  }

  private owns(repo: HistoryRepo): boolean {
    return this.db.prepare("SELECT 1 FROM repos WHERE id = ? AND profile_id = ? AND path = ?")
      .get(repo.id, repo.profileId, repo.path) !== undefined;
  }

  private async fetchRemote(
    repo: HistoryRepo, { owner, name }: { owner: string; name: string }, cached: RemoteHistory, controller: AbortController,
  ): Promise<void> {
    const { signal } = controller;
    if (signal.aborted || !this.isEnabled(GITHUB_DOT_COM) || !this.owns(repo)) return;
    const previous = cached.verified;
    let credential: string | undefined;
    let verified: NonNullable<RemoteHistory["verified"]>;
    try {
      const token = await githubProvider.getToken(GITHUB_DOT_COM);
      if (signal.aborted) return;
      if (!token) throw new Error("GitHub is signed out.");
      // A validator is only reusable with the same authenticated identity.
      const auth = createHash("sha256").update(token).digest("hex");
      credential = auth;
      const history = await fetchGitHubStacks(token, owner, name, previous?.auth === auth ? previous.history : undefined, signal, () => {
        if (!this.isEnabled(GITHUB_DOT_COM) || (this.cooldownUntil.get(auth) ?? 0) > this.now()) controller.abort();
      });
      verified = { auth, at: this.now(), history };
    } catch (cause) {
      const serverDelay = cause instanceof StackHistoryResponseError && Number.isFinite(cause.retryAfterMs)
        ? cause.retryAfterMs : 0;
      const now = this.now();
      if (credential && serverDelay > 0) {
        this.cooldownUntil.set(credential, Math.max(this.cooldownUntil.get(credential) ?? 0, now + serverDelay));
      }
      if (signal.aborted || !this.owns(repo)) return;
      const backoff = Math.min((cached.failure?.backoff ?? INITIAL_BACKOFF_MS / 2) * 2, MAX_BACKOFF_MS);
      cached.failure = { at: now, backoff, delay: Math.max(backoff, serverDelay) };
      return;
    }
    if (signal.aborted || !this.isEnabled(GITHUB_DOT_COM) || !this.owns(repo)) return;
    cached.verified = verified;
    delete cached.failure;
    if (!isDeepStrictEqual(previous?.history.stacks ?? [], verified.history.stacks)) {
      this.changed({ repoId: repo.id, profileId: repo.profileId });
    }
  }
}
