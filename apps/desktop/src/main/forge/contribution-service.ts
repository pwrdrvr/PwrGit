import { canonicalForgeHostname, contributionWindow, type ContributionIdentity, type ContributionRecord, type ContributionSnapshot, type ContributionWindow, type ForgeKind } from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import type { ForgeHosts } from "./hosts";
import { GitHubContributionProvider, ContributionRateLimitError, type ContributionProvider } from "./github/contribution-provider";
import { delay } from "../util/timing";

export type ContributionScope = { profileId: string; host: string; viewerId: string; startDate: string; endDate: string; timezone: string };
type Job = { controller: AbortController; done: Promise<void> };
type StoredSnapshot = Omit<ContributionSnapshot, "records"> & { records: (Omit<ContributionRecord, "repo"> & { repoId: string })[] };
const PROVIDERS: Record<ForgeKind, ((host: string) => ContributionProvider) | null> = {
  github: host => new GitHubContributionProvider(host), gitlab: null, gitcafe: null
};
const RETENTION_MS = 30 * 86_400_000;
const REPO_CAP = 10_000, RECORD_CAP = 20_000, ACTIVATION_PAGE_CAP = 1_000;
function windowKey(window: ContributionWindow): string { return JSON.stringify([window.startDate, window.endDate, window.timezone]); }
function key(scope: ContributionScope): string { return JSON.stringify([scope.profileId, scope.host, scope.viewerId, scope.startDate, scope.endDate, scope.timezone]); }

export class ContributionService {
  private jobs = new Map<string, Job>();
  private starting = false;
  constructor(private readonly db: DB, private readonly hosts: Pick<ForgeHosts, "kindFor" | "isEnabled">,
    private readonly providerFor: (kind: ForgeKind, host: string) => ContributionProvider | null = (kind, host) => PROVIDERS[kind]?.(host) ?? null,
    private readonly pause: (signal: AbortSignal) => Promise<void> = signal => delay(150, { signal })) {}
  private validateLocalScope(profileId: string, host: string): void {
    if (!this.db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(profileId)) throw new Error("This analytics profile no longer exists.");
    if (canonicalForgeHostname(host) !== host) throw new Error("Analytics requires a canonical forge host.");
  }
  private provider(profileId: string, host: string): ContributionProvider {
    this.validateLocalScope(profileId, host);
    if (!this.hosts.isEnabled(host).enabled) throw new Error("Enable this forge host in Settings before collecting analytics.");
    const kind = this.hosts.kindFor(host).kind;
    const provider = kind ? this.providerFor(kind, host) : null;
    if (!provider) throw new Error("Contribution analytics is not available for this forge.");
    return provider;
  }
  private window(scope: Omit<ContributionScope, "viewerId">): ContributionWindow {
    return contributionWindow(scope.startDate, scope.endDate, scope.timezone);
  }
  async verify(scope: Omit<ContributionScope, "viewerId">): Promise<{ identity: ContributionIdentity; snapshot: ContributionSnapshot | null }> {
    this.window(scope);
    const identity = await this.provider(scope.profileId, scope.host).verify(new AbortController().signal);
    if (identity.host !== scope.host) throw new Error("Forge identity did not match the requested host.");
    return { identity, snapshot: this.read({ ...scope, viewerId: identity.id }) };
  }
  read(scope: ContributionScope): ContributionSnapshot | null {
    this.validateLocalScope(scope.profileId, scope.host);
    const window = this.window(scope);
    this.db.prepare("DELETE FROM contribution_snapshots WHERE updated_at_ms < ?").run(Date.now() - RETENTION_MS);
    const row = this.db.prepare("SELECT snapshot FROM contribution_snapshots WHERE profile_id=? AND host=? AND viewer_id=? AND window_key=?").get(scope.profileId, scope.host, scope.viewerId, windowKey(window)) as { snapshot: string } | undefined;
    if (!row) return null;
    const stored = JSON.parse(row.snapshot) as StoredSnapshot;
    const repos = new Map(stored.repos.map(repo => [repo.id, repo]));
    const snapshot: ContributionSnapshot = { ...stored, records: stored.records.map(({ repoId, ...record }) => {
      const repo = repos.get(repoId);
      if (!repo) throw new Error("Analytics cache repository identity is invalid. Clear the cache and refresh.");
      return { ...record, repo };
    }) };
    if (snapshot.version !== 1 || snapshot.profileId !== scope.profileId || snapshot.identity.host !== scope.host || snapshot.identity.id !== scope.viewerId) throw new Error("Analytics cache identity is invalid. Clear the cache and refresh.");
    if (snapshot.status === "collecting" && !this.jobs.has(key(scope))) snapshot.status = "partial";
    return snapshot;
  }
  private save(snapshot: ContributionSnapshot): void {
    const stored: StoredSnapshot = { ...snapshot, records: snapshot.records.map(({ repo, ...record }) => ({ ...record, repoId: repo.id })) };
    const json = JSON.stringify(stored);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO contribution_snapshots VALUES(?,?,?,?,?,?) ON CONFLICT(profile_id,host,viewer_id,window_key) DO UPDATE SET updated_at_ms=excluded.updated_at_ms,snapshot=excluded.snapshot`).run(snapshot.profileId, snapshot.identity.host, snapshot.identity.id, windowKey(snapshot.window), Date.now(), json);
      // Four recent windows/accounts per profile; reads/writes also expire at 30 days.
      this.db.prepare(`DELETE FROM contribution_snapshots WHERE profile_id=? AND rowid NOT IN (SELECT rowid FROM contribution_snapshots WHERE profile_id=? ORDER BY updated_at_ms DESC LIMIT 4)`).run(snapshot.profileId, snapshot.profileId);
      this.db.prepare("DELETE FROM contribution_snapshots WHERE updated_at_ms < ?").run(Date.now() - RETENTION_MS);
    })();
  }
  async start(scope: ContributionScope, refresh: boolean): Promise<ContributionSnapshot> {
    if (this.starting) throw new Error("An analytics account is being verified. Try again after it finishes.");
    this.starting = true;
    try { return await this.begin(scope, refresh); } finally { this.starting = false; }
  }
  private async begin(scope: ContributionScope, refresh: boolean): Promise<ContributionSnapshot> {
    const provider = this.provider(scope.profileId, scope.host), window = this.window(scope);
    // One collector app-wide avoids duplicate account walks and shared CLI budget bursts.
    const existing = this.jobs.get(key(scope));
    if (existing) return this.read(scope)!;
    if (this.jobs.size) throw new Error("Another contribution collection is running. Wait or cancel it first.");
    const controller = new AbortController();
    const identity = await provider.verify(controller.signal);
    if (identity.id !== scope.viewerId || identity.host !== scope.host) throw new Error("The active account changed. Reconnect analytics.");
    const cached = refresh ? null : this.read(scope);
    if (cached?.status === "complete") return cached;
    if (cached?.retryAt && Date.parse(cached.retryAt) > Date.now()) throw new Error(`Resume after ${cached.retryAt}.`);
    const snapshot: ContributionSnapshot = cached ?? {
      version: 1, profileId: scope.profileId, identity, window, status: "collecting",
      startedAt: new Date().toISOString(), refreshedAt: null, repos: [], records: [], organizations: [],
      inventoryComplete: false, inventoryExpected: null, inventoryReceived: 0, organizationsComplete: false, repoCursor: null, orgCursor: null,
      repoIndex: 0, prCursor: null, pages: 0, retryAt: null, issues: [],
      authoredInventory: { cursor: null, expected: null, received: 0, seen: [], complete: false }
    };
    snapshot.status = "collecting"; snapshot.issues = []; snapshot.retryAt = null;
    this.save(snapshot);
    const job: Job = { controller, done: Promise.resolve() };
    this.jobs.set(key(scope), job);
    job.done = this.collect(scope, snapshot, provider, controller.signal).catch(() => {
      // Failed checkpoint writes leave the last stored page incomplete; no payload logging.
    }).finally(() => this.jobs.delete(key(scope)));
    return snapshot;
  }
  private async collect(scope: ContributionScope, snapshot: ContributionSnapshot, provider: ContributionProvider, signal: AbortSignal): Promise<void> {
    let activationPages = 0;
    const request = async () => {
      signal.throwIfAborted();
      if (++activationPages > ACTIVATION_PAGE_CAP) throw new Error("This pass reached its 1,000-page budget. Resume to continue the same frozen range.");
      await this.pause(signal);
      signal.throwIfAborted(); this.provider(scope.profileId, scope.host);
    };
    const nextCursor = (previous: string | null, next: string | null, more: boolean) => {
      if (more && (!next || previous === next)) throw new Error("The forge repeated a pagination cursor; coverage is incomplete.");
      return more ? next : null;
    };
    try {
      while (!snapshot.inventoryComplete) {
        await request();
        const page = await provider.repositories(snapshot.identity, snapshot.repoCursor, signal);
        if (page.totalCount === undefined || (snapshot.inventoryExpected !== null && snapshot.inventoryExpected !== page.totalCount)) throw new Error("Repository inventory count changed or was unavailable. Refresh to rediscover coverage.");
        const repos = new Map(snapshot.repos.map(repo => [repo.id, repo]));
        for (const repo of page.nodes) {
          if (repos.has(repo.id)) throw new Error("Repository inventory repeated a node ID. Refresh to rediscover coverage.");
          repos.set(repo.id, repo);
        }
        if (repos.size > REPO_CAP) throw new Error("Repository inventory exceeds the 10,000-repository storage limit.");
        const cursor = nextCursor(snapshot.repoCursor, page.cursor, page.more);
        const received = snapshot.inventoryReceived + page.nodes.length;
        if (received > page.totalCount || (!page.more && received !== page.totalCount)) throw new Error("Repository inventory count does not match received nodes. Coverage is incomplete.");
        snapshot.inventoryExpected = page.totalCount; snapshot.inventoryReceived = received;
        snapshot.repos = [...repos.values()]; snapshot.repoCursor = cursor; snapshot.inventoryComplete = !page.more; snapshot.pages++; this.save(snapshot);
      }
      while (!snapshot.organizationsComplete) {
        await request();
        const page = await provider.organizations(snapshot.identity, snapshot.orgCursor, signal);
        const cursor = nextCursor(snapshot.orgCursor, page.cursor, page.more);
        snapshot.organizations = [...new Set([...snapshot.organizations, ...page.nodes])];
        snapshot.orgCursor = cursor; snapshot.organizationsComplete = !page.more; snapshot.pages++; this.save(snapshot);
      }
      const records = new Map(snapshot.records.map(row => [JSON.stringify([row.repo.id, row.id]), row]));
      // Direct lifetime author inventory covers personal/external projects without search indexing.
      while (!snapshot.authoredInventory.complete) {
        await request();
        const inventory = snapshot.authoredInventory;
        const page = await provider.authored(snapshot.identity, inventory.cursor, signal);
        if (page.totalCount === undefined || (inventory.expected !== null && inventory.expected !== page.totalCount)) throw new Error("Authored inventory count changed or was unavailable. Restart discovery.");
        const seen = new Set(inventory.seen), repos = new Map(snapshot.repos.map(repo => [repo.id, repo]));
        const additions = new Map(records);
        for (const row of page.nodes) {
          if (row.author !== snapshot.identity.id || !row.lifecycle) throw new Error("An authored inventory node does not belong to the verified viewer.");
          if (seen.has(row.id)) throw new Error("Authored inventory repeated a PR node ID. Restart discovery.");
          seen.add(row.id);
          const repo = repos.get(row.repo.id) ?? { ...row.repo, source: "authored_inventory" as const };
          repos.set(repo.id, repo); row.repo = repo;
          const mergedAt = row.mergedAt ? Date.parse(row.mergedAt) : NaN;
          if (Date.parse(row.lifecycle.createdAt) < Date.parse(snapshot.window.end) && (!row.mergedAt || mergedAt >= Date.parse(snapshot.window.start))) {
            if (Date.parse(row.lifecycle.updatedAt) < Date.parse(snapshot.window.start) && row.lifecycle.state === "CLOSED") {
              row.lifecycle.frozenState = row.lifecycle.state; row.lifecycle.complete = true;
            }
            additions.set(JSON.stringify([row.repo.id, row.id]), row);
          }
        }
        const received = inventory.received + page.nodes.length;
        if (received > page.totalCount || (!page.more && (received !== page.totalCount || seen.size !== page.totalCount))) throw new Error("Authored inventory count does not match distinct received PRs.");
        if (seen.size > RECORD_CAP || additions.size > RECORD_CAP) throw new Error("Authored inventory exceeds the 20,000-PR metadata limit.");
        if (repos.size > REPO_CAP) throw new Error("Authored repositories exceed the 10,000-repository limit.");
        const cursor = nextCursor(inventory.cursor, page.cursor, page.more);
        snapshot.repos = [...repos.values()]; inventory.cursor = cursor; inventory.expected = page.totalCount; inventory.received = received; inventory.seen = [...seen]; inventory.complete = !page.more;
        records.clear(); for (const [id, row] of additions) records.set(id, row);
        snapshot.records = [...records.values()]; snapshot.pages++; this.save(snapshot);
      }
      while (snapshot.repoIndex < snapshot.repos.length) {
        const repo = snapshot.repos[snapshot.repoIndex]!;
        // External authored activity is already complete from viewer.pullRequests.
        // Do not scan tens of thousands of unrelated PRs in contributed projects.
        if (repo.source === "authored_inventory") { snapshot.repoIndex++; this.save(snapshot); continue; }
        await request();
        const page = await provider.pulls(snapshot.identity, repo, snapshot.prCursor, signal);
        // Process the entire page before applying the UPDATED_AT stop boundary.
        const cursor = nextCursor(snapshot.prCursor, page.cursor, page.more);
        const additions = page.nodes.filter(row => row.mergedAt && Date.parse(row.mergedAt) >= Date.parse(snapshot.window.start) && Date.parse(row.mergedAt) < Date.parse(snapshot.window.end) && row.mergedBy === snapshot.identity.id);
        const next = new Map(records);
        for (const row of additions) {
          const id = JSON.stringify([row.repo.id, row.id]);
          if (!next.has(id)) next.set(id, row);
        }
        if (next.size > RECORD_CAP) throw new Error("Matching metadata exceeds the 20,000-PR storage limit. Select a shorter range.");
        for (const [id, row] of next) records.set(id, row);
        snapshot.records = [...records.values()];
        if (!page.more || (page.oldestUpdatedAt !== null && Date.parse(page.oldestUpdatedAt) < Date.parse(snapshot.window.start))) {
          snapshot.repoIndex++; snapshot.prCursor = null;
        } else snapshot.prCursor = cursor;
        snapshot.pages++; this.save(snapshot);
      }
      while (true) {
        const pending = snapshot.records.filter(row => row.lifecycle && !row.lifecycle.complete).slice(0, 25);
        if (!pending.length) break;
        await request();
        const pages = await provider.timelines(snapshot.identity, pending, signal);
        if (pages.length !== pending.length) throw new Error("Some PR lifecycle histories were not returned.");
        const updates = pending.map(row => {
          const page = pages.find(page => page.id === row.id), lifecycle = row.lifecycle!;
          if (!page) throw new Error("PR lifecycle history was unavailable.");
          const expected = lifecycle.expected ?? page.filteredCount;
          const cursor = nextCursor(lifecycle.cursor, page.cursor, page.more);
          const events = new Map(lifecycle.events.map(event => [event.id, event]));
          for (const event of page.events) { if (events.has(event.id)) throw new Error("PR lifecycle history repeated an event ID."); events.set(event.id, event); }
          if (events.size > expected || (!page.more && events.size !== expected)) throw new Error("PR lifecycle count does not match the initial filtered event count. Refresh to collect a consistent snapshot.");
          if (events.size > 2000) throw new Error("A PR exceeds the 2,000 lifecycle event limit.");
          if (!page.more) {
            const merges = [...events.values()].filter(event => event.kind === "merged");
            if (merges.length !== (row.mergedAt ? 1 : 0)) throw new Error("PR history must contain exactly one terminal merge event for a merged PR.");
            const mergeEvent = merges[0];
            if (mergeEvent && [...events.values()].some(event => event.kind !== "merged" && !(event.kind === "closed" && (Date.parse(event.at) === Date.parse(mergeEvent.at) || Date.parse(event.at) === Date.parse(row.mergedAt!))) && Date.parse(event.at) >= Date.parse(mergeEvent.at))) throw new Error("PR lifecycle contains a state transition after its terminal merge event.");
            let state: "OPEN" | "CLOSED" | "MERGED" = "OPEN";
            const transitions = [...events.values()].map(event => event.kind === "merged" && row.mergedAt ? { ...event, at: row.mergedAt } : event);
            for (const event of transitions.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
              if (Date.parse(event.at) > Date.parse(lifecycle.updatedAt)) break;
              if (event.kind === "closed" && mergeEvent && (Date.parse(event.at) === Date.parse(mergeEvent.at) || Date.parse(event.at) === Date.parse(row.mergedAt!))) continue;
              state = event.kind === "closed" ? "CLOSED" : event.kind === "merged" ? "MERGED" : "OPEN";
            }
            if (row.mergedAt && Date.parse(row.mergedAt) <= Date.parse(lifecycle.updatedAt)) state = "MERGED";
            if (state !== lifecycle.state) throw new Error("Lifecycle history does not reconcile with the PR's recorded state. Refresh to collect a consistent snapshot.");
          }
          return { row, lifecycle: { ...lifecycle, events: [...events.values()], complete: !page.more, cursor, expected } };
        });
        const eventCount = snapshot.records.reduce((sum, row) => sum + (row.lifecycle?.events.length ?? 0), 0) + updates.reduce((sum, update) => sum + update.lifecycle.events.length - update.row.lifecycle!.events.length, 0);
        if (eventCount > 50_000) throw new Error("Lifecycle metadata exceeds the 50,000-event storage limit. Select a shorter range.");
        for (const update of updates) update.row.lifecycle = update.lifecycle;
        snapshot.pages++; this.save(snapshot);
      }
      signal.throwIfAborted();
      snapshot.status = "complete"; snapshot.refreshedAt = new Date().toISOString();
    } catch (cause) {
      snapshot.status = signal.aborted ? "canceled" : "partial";
      snapshot.issues = [{ repoId: snapshot.repos[snapshot.repoIndex]?.id ?? null, message: cause instanceof Error ? cause.message : "Collection stopped; coverage is incomplete." }];
      snapshot.retryAt = cause instanceof ContributionRateLimitError ? cause.retryAt : null;
    }
    // A profile deletion cascades snapshots; an in-flight read must not recreate it.
    if (this.db.prepare("SELECT 1 FROM profiles WHERE id=?").get(scope.profileId)) this.save(snapshot);
  }
  async cancel(scope: ContributionScope): Promise<void> {
    this.validateLocalScope(scope.profileId, scope.host);
    const job = this.jobs.get(key(scope));
    if (job) { job.controller.abort(); await job.done; }
  }
  async clear(scope: ContributionScope): Promise<void> {
    this.validateLocalScope(scope.profileId, scope.host);
    const accountJobs = [...this.jobs.entries()].filter(([jobKey]) => {
      const [profileId, host, viewerId] = JSON.parse(jobKey) as string[];
      return profileId === scope.profileId && host === scope.host && viewerId === scope.viewerId;
    }).map(([, job]) => job);
    for (const job of accountJobs) job.controller.abort();
    await Promise.all(accountJobs.map(job => job.done));
    this.db.prepare("DELETE FROM contribution_snapshots WHERE profile_id=? AND host=? AND viewer_id=?").run(scope.profileId, scope.host, scope.viewerId);
  }
  stop(): void { for (const job of this.jobs.values()) job.controller.abort(); }
  async settled(): Promise<void> { await Promise.all([...this.jobs.values()].map(job => job.done)); }
}
