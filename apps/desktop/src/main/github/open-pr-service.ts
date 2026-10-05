import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  changeRequestHeadRef,
  changeRequestLocalBranch,
  err,
  forgeRepoKey,
  forgeSignInCommand,
  ok,
  type ChangeRequestEntry,
  type ChangeRequestList,
  type ChangeRequestListFailure,
  type ChangeRequestLocation,
  type ChangeRequestRemote,
  type ChangeRequestView,
  type ChangeRequestViewCommit,
  type ChangeRequestViewHead,
  type OpenChangeRequest,
  type PrSummary,
  type Result
} from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";
import { fetchRefspec } from "../git/git-service";
import type { DB } from "../persistence/db";
import {
  checkoutRefsFromRefnames,
  locateChangeRequest,
  type ChangeRequestPlace,
  type CheckoutRefs
} from "../forge/change-request-location";
import { resolveForge, type ResolvedForge } from "../forge/providers";
import { OPEN_PR_COLUMNS, openPrFromRow, openPrSelect } from "../forge/pr-row";
import { connectForge, type OpenPrList } from "../forge/types";

/** A list refresh riding the repo sweep (repo expand, lineage load). */
const SCHEDULED_OPEN_LIST_TTL_MS = 10 * 60_000;
/** A list refresh asked for by opening the refs browser. */
const USER_OPEN_LIST_TTL_MS = 60_000;
/** A number looked up because the open list could not answer it. */
const LOOKUP_TTL_MS = 5 * 60_000;

/** Commits the PR view lists; a longer branch says it was cut. */
const VIEW_COMMITS_MAX = 250;
/** A patch longer than this is not sent: the view lists the commits and
 *  says it is too large to draw, rather than freezing the renderer. */
const VIEW_PATCH_MAX_CHARS = 8 * 1024 * 1024;

export type OpenListTrigger = "scheduled" | "user";

type OpenPrServiceDeps = {
  resolveForge?: typeof resolveForge;
  now?: () => number;
};

type StoredRow = Record<(typeof OPEN_PR_COLUMNS)[number], unknown>;

/**
 * A forge repository this checkout has a remote on. Remotes that point at the
 * same repository are one of these, named after the first (`origin` first).
 */
type ForgeRemote = {
  name: string;
  /** Every remote pointing here — tracking refs live under each. */
  names: string[];
  /** `forgeRepoKey(host, path)`: the cache's key. */
  key: string;
  forge: ResolvedForge;
};

const COLUMN_LIST = OPEN_PR_COLUMNS.join(", ");
const WRITE_COLUMNS = ["head_forge_repo", ...OPEN_PR_COLUMNS] as const;
const WRITE_COLUMN_LIST = WRITE_COLUMNS.join(", ");
const WRITE_COLUMN_PARAMS = WRITE_COLUMNS.map((column) => `@${column}`).join(", ");
const WRITE_COLUMN_UPDATES = WRITE_COLUMNS.filter((column) => column !== "number")
  .map((column) => `${column} = excluded.${column}`)
  .join(", ");

/**
 * A repository's open change requests: the one forge read not keyed by a local
 * ref, so the only one that can find a PR whose head this checkout has never
 * seen. Sibling of `PrService`, and built the same way — resolved providers,
 * a TTL for freshness, an in-memory mark for a refresh that failed, and a
 * generation that profile deletion bumps so a response already in flight
 * cannot write into a deleted profile.
 *
 * One list per forge repository the checkout has a remote on, not just
 * `origin`'s: in a fork checkout `origin` is your own repository, and the PR
 * you sent to the original is only on `upstream`'s list. Each list has its own
 * freshness and its own failure, so one forge refusing never blanks another's.
 *
 * It does not share `PrService`'s tables or backoff: the list is a different
 * question with a different cost (a page walk, not a batch of keys), and a
 * forge that refuses one routinely answers the other.
 */
export class OpenPrService {
  private readonly resolveForge: typeof resolveForge;
  private readonly now: () => number;
  private writeGeneration = 0;
  private readonly pending = new Map<string, Promise<boolean>>();
  /**
   * See `PrService.lastFailedAt`: never cache a failure, but remember it —
   * here with its reason too, because `list()` reports it to the reader.
   * Keyed by `listKey`: one per repository and forge repository.
   */
  private readonly lastFailure = new Map<string, ChangeRequestListFailure>();
  /**
   * When a forge repository other than the primary one (`origin`'s) was
   * found to have no sign-in. It is not asked again inside the TTL, and is left out of
   * `list()`: a mirror on a forge you never connected is not a list that
   * failed. Keyed by `listKey`.
   */
  private readonly unasked = new Map<string, number>();
  /** Each repository's remote URLs, stamped with its config file. */
  private readonly remoteUrls = new Map<
    string,
    { stamp: string; urls: { name: string; url: string }[] }
  >();
  private readonly lookups = new Map<
    string,
    { at: number; pr: OpenChangeRequest | null }
  >();

  constructor(
    private readonly db: DB,
    private readonly git: GitExec,
    deps: OpenPrServiceDeps = {}
  ) {
    this.resolveForge = deps.resolveForge ?? resolveForge;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Profile deletion: nothing in flight may write, and no backoff survives. */
  invalidatePendingWrites(): void {
    this.writeGeneration += 1;
    this.lastFailure.clear();
    this.unasked.clear();
    this.lookups.clear();
  }

  /**
   * Re-list each of the repository's forge repositories whose cached list is
   * not fresh enough for `trigger`, together. Resolves true when any refresh
   * ran to an answer — a list stored, or a failure recorded — or a remote's
   * rows were dropped, because each moves what `list()` reports, so the
   * caller should announce it. Resolves false when nothing ran: fresh, backing
   * off, no forge, or superseded. A caller that arrives while a refresh is in
   * flight waits for it and resolves false — the first caller announces.
   */
  async refresh(
    repoId: string,
    opts: { trigger?: OpenListTrigger; force?: boolean } = {}
  ): Promise<boolean> {
    const inFlight = this.pending.get(repoId);
    if (inFlight !== undefined) {
      await inFlight;
      return false;
    }
    const ttl =
      opts.trigger === "user" ? USER_OPEN_LIST_TTL_MS : SCHEDULED_OPEN_LIST_TTL_MS;
    const run = this.refreshNow(repoId, this.writeGeneration, {
      ttl,
      force: opts.force === true
    });
    this.pending.set(repoId, run);
    try {
      return await run;
    } finally {
      this.pending.delete(repoId);
    }
  }

  /**
   * The cached lists, each entry located in this checkout.
   *
   * Spawns nothing in the common case: the sidebar reads this on every repo
   * expand and every announcement. Heads are located against the branch index
   * (`indexedCheckoutRefs`), and the remotes are re-read only when the repo's
   * config changes. The verbs that act on a location re-locate it against git
   * first (`fetchHead`), so a stale index costs a label, never a wrong action.
   */
  async list(repoId: string): Promise<ChangeRequestList> {
    const none: ChangeRequestList = {
      forge: null,
      fetchedAt: null,
      truncated: false,
      entries: [],
      remotes: []
    };
    const path = this.repoPath(repoId);
    if (path === undefined) return none;
    const all = (await this.forgeRemotes(path)) ?? [];
    const listed = all.filter((remote) => !this.unasked.has(listKey(repoId, remote.key)));
    const first = listed[0];
    if (first === undefined) return none;
    const states = new Map(
      (
        this.db
          .prepare(
            "SELECT forge_repo, fetched_at, truncated FROM repo_open_pr_state WHERE repo_id = ?"
          )
          .all(repoId) as { forge_repo: string; fetched_at: number; truncated: number }[]
      ).map((row) => [row.forge_repo, row] as const)
    );
    const byKey = new Map(listed.map((remote) => [remote.key, remote] as const));
    const refs = this.indexedCheckoutRefs(repoId);
    const entries: ChangeRequestEntry[] = [];
    for (const { forgeRepo, pr } of this.cachedOpen(repoId)) {
      const remote = byKey.get(forgeRepo);
      if (remote === undefined) continue;
      entries.push({
        pr,
        location: locateChangeRequest(
          pr,
          pr.forge ?? remote.forge.repo.kind,
          refs,
          placeFor(pr, remote, all)
        ),
        remote: remote.name,
        forgeRepo
      });
    }
    const remotes = listed.map((remote): ChangeRequestRemote => {
      const state = states.get(remote.key);
      const failure = this.lastFailure.get(listKey(repoId, remote.key));
      return {
        name: remote.name,
        forge: remote.forge.repo.kind,
        forgeRepo: remote.key,
        path: remote.forge.repo.path,
        fetchedAt: state?.fetched_at ?? null,
        truncated: state?.truncated === 1,
        ...(failure === undefined ? {} : { failure })
      };
    });
    const landed = remotes.flatMap((remote) =>
      remote.fetchedAt === null ? [] : [remote.fetchedAt]
    );
    const failed = remotes
      .filter((remote) => remote.failure !== undefined)
      .sort((a, b) => (b.failure?.at ?? 0) - (a.failure?.at ?? 0))[0];
    return {
      forge: first.forge.repo.kind,
      fetchedAt: landed.length === 0 ? null : Math.min(...landed),
      truncated: remotes.some((remote) => remote.truncated),
      entries,
      remotes,
      ...(failed?.failure === undefined
        ? {}
        : {
            failure:
              remotes.length > 1
                ? { ...failed.failure, message: `${failed.name}: ${failed.failure.message}` }
                : failed.failure
          })
    };
  }

  /**
   * One change request by number: from the open list when it is there, else
   * asked of the forge — a merged PR, or one opened since the last list. An
   * answer (including "no such number") is remembered briefly; a failure is
   * not, so the next keystroke may try again.
   *
   * `forgeRepo` says whose #N is meant. Without it, a listed number is found
   * on whichever remote lists it (`origin` first), and an unlisted one is
   * asked of `origin`.
   */
  async lookup(
    repoId: string,
    number: number,
    forgeRepo?: string
  ): Promise<ChangeRequestEntry | null> {
    const path = this.repoPath(repoId);
    if (path === undefined || !Number.isSafeInteger(number) || number < 1) {
      return null;
    }
    const all = (await this.forgeRemotes(path)) ?? [];
    const target = this.targetFor(repoId, number, all, forgeRepo);
    if (target === null) return null;
    const pr = await this.findByNumber(repoId, number, target);
    if (pr === null) return null;
    const refs = await this.checkoutRefs(repoId, path, all);
    return {
      pr,
      location: locateChangeRequest(
        pr,
        target.forge.repo.kind,
        refs,
        placeFor(pr, target, all)
      ),
      remote: target.name,
      forgeRepo: target.key
    };
  }

  /**
   * Bring change request `number`'s head into this checkout, and say where it
   * landed. A head already here is returned as-is — nothing is re-fetched over
   * a branch someone may have committed on.
   *
   * - A head in a repository this checkout has a remote on (the listing
   *   repository, or your fork for a PR you sent to the original), not
   *   fetched: that remote's branch into its ordinary remote-tracking ref, so
   *   the branch verbs treat it like any fetched branch.
   * - Any other fork: the forge's change-request ref, from the listing
   *   remote, into the numbered local branch, with `branch.<name>.merge`
   *   pointing back at that ref so a later pull follows the change request.
   *   There is no push target, deliberately: the fork is somebody else's
   *   repository.
   */
  async fetchHead(
    repoId: string,
    number: number,
    forgeRepo?: string
  ): Promise<Result<ChangeRequestLocation>> {
    const path = this.repoPath(repoId);
    if (path === undefined) {
      return err({ kind: "repo", code: "not_found", message: "Repository not found." });
    }
    const all = (await this.forgeRemotes(path)) ?? [];
    const target = this.targetFor(repoId, number, all, forgeRepo);
    if (target === null) {
      return err({
        kind: "remote",
        code: "no_forge",
        message:
          forgeRepo === undefined
            ? "None of this repository's remotes is on a forge PwrGit can ask."
            : "No remote of this repository points at that forge repository any more."
      });
    }
    const kind = target.forge.repo.kind;
    const pr = await this.findByNumber(repoId, number, target);
    if (pr === null) {
      return err({
        kind: "remote",
        code: "not_found",
        message: `No change request #${number} was found on ${target.name}.`
      });
    }
    const location = locateChangeRequest(
      pr,
      kind,
      await this.checkoutRefs(repoId, path, all),
      placeFor(pr, target, all)
    );
    if (location.kind === "unfetched") {
      const valid = await this.isBranchName(path, location.branch);
      if (!valid) return invalidHead(location.branch);
      const fullName = `refs/remotes/${location.remote}/${location.branch}`;
      const fetched = await fetchRefspec(
        this.git,
        path,
        location.remote,
        `+refs/heads/${location.branch}:${fullName}`
      );
      if (!fetched.ok) return fetched;
      return ok({ kind: "remote", branch: location.branch, fullName });
    }
    if (location.kind === "fork") {
      const ref = changeRequestHeadRef(kind, number);
      if (ref === null || !location.fetchable) {
        return err({
          kind: "remote",
          code: "unsupported",
          message: "This forge publishes no ref PwrGit can check a fork's change request out from."
        });
      }
      const valid = await this.isBranchName(path, location.localBranch);
      if (!valid) return invalidHead(location.localBranch);
      // No `+`: the branch does not exist (the location says so), and if it
      // appeared since, refusing is right — it may hold someone's commits.
      const fetched = await fetchRefspec(
        this.git,
        path,
        location.remote,
        `${ref}:refs/heads/${location.localBranch}`
      );
      if (!fetched.ok) return fetched;
      for (const [key, value] of [
        ["remote", location.remote],
        ["merge", ref]
      ] as const) {
        await this.git(
          ["config", `branch.${location.localBranch}.${key}`, value],
          path
        );
      }
      return ok({ kind: "local", branch: location.localBranch });
    }
    if (location.kind === "missing") {
      return err({
        kind: "remote",
        code: "branch_gone",
        message: "This change request's branch no longer exists."
      });
    }
    return ok(location);
  }

  /**
   * A listed change request's diff for the PR view: its head as this checkout
   * holds it, from the merge base with its base branch's tracking ref. Asks
   * the forge nothing — the entry comes from the cache — and fetches only with
   * `fetch`, never into a branch:
   *
   * - a same-repository head that is not here, into its remote-tracking ref
   *   (where `fetchHead` puts it too, so + Worktree finds it afterwards);
   * - a fork's head, or one whose branch is gone, through the forge's
   *   change-request ref into `refs/pwrgit/cr/<remote>/<n>`, which a later
   *   list refresh prunes once the change request leaves the list;
   * - a base branch with no tracking ref, into its tracking ref.
   *
   * When the local branch and the forge's head (`pr.headOid`) differ, the
   * newer is shown unless `show` says which. `fetched` says whether any ref
   * moved, so the caller can re-index.
   */
  async view(
    repoId: string,
    number: number,
    forgeRepo: string,
    options: { fetch: boolean; show?: "local" | "forge" }
  ): Promise<Result<{ view: ChangeRequestView; fetched: boolean }>> {
    const path = this.repoPath(repoId);
    if (path === undefined) {
      return err({ kind: "repo", code: "not_found", message: "Repository not found." });
    }
    const all = (await this.forgeRemotes(path)) ?? [];
    const target = this.targetFor(repoId, number, all, forgeRepo);
    const pr = target === null ? null : await this.findByNumber(repoId, number, target);
    if (target === null || pr === null) {
      return err({
        kind: "remote",
        code: "not_found",
        message: `#${number} is not on this repository's open list any more.`
      });
    }
    const place = placeFor(pr, target, all);
    const location = locateChangeRequest(
      pr,
      target.forge.repo.kind,
      await this.checkoutRefs(repoId, path, all),
      place
    );
    let fetched = false;
    const fetchInto = async (remote: string, refspec: string): Promise<Result<void>> => {
      const result = await fetchRefspec(this.git, path, remote, refspec);
      if (result.ok) fetched = true;
      return result;
    };
    const view = await this.resolveView(
      path,
      target,
      { pr, location, headRemote: place.headRemote },
      options,
      fetchInto
    );
    return ok({ view, fetched });
  }

  private async resolveView(
    path: string,
    target: ForgeRemote,
    {
      pr,
      location,
      headRemote
    }: { pr: OpenChangeRequest; location: ChangeRequestLocation; headRemote: string | null },
    { fetch, show }: { fetch: boolean; show?: "local" | "forge" },
    fetchInto: (remote: string, refspec: string) => Promise<Result<void>>
  ): Promise<ChangeRequestView> {
    const entry: ChangeRequestEntry = {
      pr,
      location,
      remote: target.name,
      forgeRepo: target.key
    };
    const unavailable = (message: string): ChangeRequestView => ({
      state: "unavailable",
      entry,
      message
    });
    const number = pr.number;
    const crRef = changeRequestHeadRef(target.forge.repo.kind, number);
    const crName = crRef?.replace(/^refs\//, "") ?? null;
    const viewRef = `refs/pwrgit/cr/${target.name}/${number}`;
    const asFetched = (oid: string): ChangeRequestViewHead => ({
      oid,
      holder: { kind: "fetched", source: crRef ?? oid, remote: target.name }
    });
    /** The forge's change-request ref, fetched into the hidden ref. */
    const fetchByNumber = async (): Promise<ChangeRequestViewHead | string> => {
      if (crRef === null) return "This forge publishes no ref to fetch a change request from.";
      const result = await fetchInto(target.name, `+${crRef}:${viewRef}`);
      if (!result.ok) return `Couldn't fetch ${crName}: ${result.error.message}`;
      const oid = await this.commitOid(path, viewRef);
      return oid === null ? `${crName} fetched nothing.` : asFetched(oid);
    };

    // What this checkout holds as the head: its worktree's or local branch,
    // or the remote-tracking branch.
    let local: ChangeRequestViewHead | null = null;
    if (location.kind === "worktree" || location.kind === "local") {
      const oid = await this.commitOid(path, `refs/heads/${location.branch}`);
      if (oid !== null) {
        local = {
          oid,
          holder:
            location.kind === "worktree"
              ? { kind: "worktree", branch: location.branch, worktreeId: location.worktreeId }
              : { kind: "local", branch: location.branch }
        };
      }
    } else if (location.kind === "remote") {
      const oid = await this.commitOid(path, location.fullName);
      if (oid !== null) {
        local = {
          oid,
          holder: { kind: "remote", name: location.fullName.replace(/^refs\/remotes\//, "") }
        };
      }
    }

    if (local === null && location.kind === "unfetched") {
      // A same-repository branch one fetch away: into its tracking ref.
      if (!(await this.isBranchName(path, location.branch))) {
        return unavailable(`The forge named the head “${location.branch}”, which is not a branch name.`);
      }
      const name = `${location.remote}/${location.branch}`;
      if (!fetch) return { state: "needsFetch", entry, what: name };
      const fullName = `refs/remotes/${name}`;
      const result = await fetchInto(location.remote, `+refs/heads/${location.branch}:${fullName}`);
      if (!result.ok) return unavailable(`Couldn't fetch ${name}: ${result.error.message}`);
      const oid = await this.commitOid(path, fullName);
      if (oid === null) return unavailable(`${name} fetched nothing.`);
      entry.location = { kind: "remote", branch: location.branch, fullName };
      local = { oid, holder: { kind: "remote", name } };
    }

    let forge: ChangeRequestViewHead | null = null;
    if (local === null) {
      // A fork's head, or one whose branch is gone: the forge's ref by
      // number, from the hidden ref when an earlier look fetched it and the
      // forge has not moved since.
      const kept = await this.commitOid(path, viewRef);
      const current = kept !== null && (pr.headOid === undefined || pr.headOid === kept);
      if (kept !== null && (current || !fetch)) {
        forge = asFetched(kept);
      } else if (crRef === null) {
        return unavailable(
          location.kind === "missing"
            ? "This change request's branch no longer exists, and this forge publishes no ref for it."
            : "This forge publishes no ref to fetch a fork's change request from."
        );
      } else if (!fetch) {
        return { state: "needsFetch", entry, what: `${crName} from ${target.name}` };
      } else {
        const head = await fetchByNumber();
        if (typeof head === "string") return unavailable(head);
        forge = head;
      }
    } else if (pr.headOid === undefined) {
      forge = null;
    } else if (pr.headOid === local.oid) {
      forge = local;
    } else if (await this.hasCommit(path, pr.headOid)) {
      // Here already: say which ref holds it — the head's tracking branch
      // when a fetch moved it past a local branch, else the hidden ref.
      const tracking =
        headRemote === null || pr.headRefName === undefined
          ? null
          : `${headRemote}/${pr.headRefName}`;
      forge =
        tracking !== null &&
        (await this.commitOid(path, `refs/remotes/${tracking}`)) === pr.headOid
          ? { oid: pr.headOid, holder: { kind: "remote", name: tracking } }
          : asFetched(pr.headOid);
    } else if (show === "forge" && fetch) {
      const head = await fetchByNumber();
      if (typeof head === "string") return unavailable(head);
      forge = head;
    }

    let relation: Extract<ChangeRequestView, { state: "ready" }>["relation"] = {
      kind: "unknown"
    };
    if (local !== null && forge !== null) {
      relation = local.oid === forge.oid ? { kind: "same" } : await this.relate(path, local.oid, forge.oid);
    }
    // Newer by default: the forge's head when the local branch is behind it,
    // the local one when it is ahead (unpushed work) or they diverged.
    const shown: "local" | "forge" =
      local === null
        ? "forge"
        : forge === null
          ? "local"
          : (show ?? (relation.kind === "behind" ? "forge" : "local"));
    const head = shown === "forge" ? (forge ?? local) : (local ?? forge);
    if (head === null) return unavailable("Nothing in this checkout holds this change request's head.");

    const baseBranch = pr.baseRefName;
    if (baseBranch === undefined) {
      return unavailable("The forge did not say which branch this change request targets.");
    }
    let base: { name: string; oid: string } | null = null;
    for (const name of target.names) {
      const oid = await this.commitOid(path, `refs/remotes/${name}/${baseBranch}`);
      if (oid !== null) {
        base = { name: `${name}/${baseBranch}`, oid };
        break;
      }
    }
    if (base === null) {
      const name = `${target.name}/${baseBranch}`;
      if (!(await this.isBranchName(path, baseBranch))) {
        return unavailable(`The forge named the base “${baseBranch}”, which is not a branch name.`);
      }
      if (!fetch) return { state: "needsFetch", entry, what: name };
      const fullName = `refs/remotes/${name}`;
      const result = await fetchInto(target.name, `+refs/heads/${baseBranch}:${fullName}`);
      if (!result.ok) return unavailable(`Couldn't fetch ${name}: ${result.error.message}`);
      const oid = await this.commitOid(path, fullName);
      if (oid === null) return unavailable(`${name} fetched nothing.`);
      base = { name, oid };
    }

    const mergeBase = await this.git(["merge-base", base.oid, head.oid], path);
    const from = mergeBase.ok && mergeBase.value.exitCode === 0 ? mergeBase.value.stdout.trim() : "";
    if (from === "") {
      return unavailable(`${base.name} and this head share no history here. The checkout may be shallow.`);
    }
    const log = await this.git(
      [
        "log",
        "--no-color",
        `--max-count=${VIEW_COMMITS_MAX + 1}`,
        "--format=%H%x1f%an%x1f%at%x1f%s",
        `${from}..${head.oid}`
      ],
      path
    );
    if (!log.ok || log.value.exitCode !== 0) {
      return unavailable("git could not list this change request's commits.");
    }
    const commits = parseViewLog(log.value.stdout);
    const diff = await this.git(["diff", "--no-color", "--no-ext-diff", "-M", from, head.oid], path);
    if (!diff.ok || diff.value.exitCode !== 0) {
      return unavailable("git could not diff this change request.");
    }
    return {
      state: "ready",
      entry,
      local,
      forge,
      relation,
      head,
      shown,
      base: { ...base, mergeBase: from },
      commits: commits.slice(0, VIEW_COMMITS_MAX),
      commitsTruncated: commits.length > VIEW_COMMITS_MAX,
      patch: diff.value.stdout.length > VIEW_PATCH_MAX_CHARS ? null : diff.value.stdout
    };
  }

  /** How `local` relates to `forge`: commits only one side has. */
  private async relate(
    path: string,
    local: string,
    forge: string
  ): Promise<Extract<ChangeRequestView, { state: "ready" }>["relation"]> {
    const out = await this.git(["rev-list", "--left-right", "--count", `${local}...${forge}`], path);
    if (!out.ok || out.value.exitCode !== 0) return { kind: "unknown" };
    const [ahead, behind] = out.value.stdout.trim().split(/\s+/).map(Number);
    if (ahead === undefined || behind === undefined || !Number.isFinite(ahead) || !Number.isFinite(behind)) {
      return { kind: "unknown" };
    }
    if (behind === 0) return { kind: "ahead", count: ahead };
    if (ahead === 0) return { kind: "behind", count: behind };
    return { kind: "diverged", ahead, behind };
  }

  /**
   * Drop the hidden refs `view` fetched for change requests that are no
   * longer on `remote`'s list. A truncated list says nothing about the rest,
   * so nothing goes then.
   */
  private async pruneViewRefs(path: string, remote: ForgeRemote, list: OpenPrList): Promise<void> {
    if (list.truncated) return;
    const prefix = `refs/pwrgit/cr/${remote.name}/`;
    const out = await this.git(["for-each-ref", "--format=%(refname)", prefix], path);
    if (!out.ok || out.value.exitCode !== 0) return;
    const open = new Set(list.items.map((item) => String(item.number)));
    for (const ref of out.value.stdout.split("\n")) {
      const name = ref.trim();
      if (!name.startsWith(prefix) || open.has(name.slice(prefix.length))) continue;
      await this.git(["update-ref", "-d", name], path);
    }
  }

  private async commitOid(path: string, ref: string): Promise<string | null> {
    const out = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], path);
    if (!out.ok || out.value.exitCode !== 0) return null;
    const oid = out.value.stdout.trim();
    return oid === "" ? null : oid;
  }

  private async hasCommit(path: string, oid: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,64}$/i.test(oid)) return false;
    const out = await this.git(["cat-file", "-e", `${oid}^{commit}`], path);
    return out.ok && out.value.exitCode === 0;
  }

  /**
   * The open lists keyed by the branch names that hold each head, for
   * decorating branch rows: `remotes` by remote, then head name
   * (same-repository heads only, under the remote that listed them), and
   * `local` by head name plus each fork's numbered branch (`pr/121`,
   * `pr/upstream/121`). Newest update wins when two change requests share a
   * head.
   *
   * Answered from the cache alone — no forge, no git — so a refs browser can
   * paint with it on open. Which remote listed a row is the one recorded at
   * its last refresh.
   */
  branchPrs(repoId: string): {
    local: Map<string, OpenChangeRequest>;
    remotes: Map<string, Map<string, OpenChangeRequest>>;
  } {
    const local = new Map<string, OpenChangeRequest>();
    const remotes = new Map<string, Map<string, OpenChangeRequest>>();
    const claim = (
      map: Map<string, OpenChangeRequest>,
      branch: string,
      pr: OpenChangeRequest
    ): void => {
      if (!map.has(branch)) map.set(branch, pr);
    };
    const listedBy = new Map(
      (
        this.db
          .prepare("SELECT forge_repo, remote FROM repo_open_pr_state WHERE repo_id = ?")
          .all(repoId) as { forge_repo: string; remote: string }[]
      ).map((row) => [row.forge_repo, row.remote] as const)
    );
    for (const { forgeRepo, headForgeRepo, pr } of this.cachedOpen(repoId)) {
      const listing = listedBy.get(forgeRepo) ?? "origin";
      // The remote holding the head: the listing one, or — for a fork this
      // checkout also has a remote on (your fork, for a PR sent upstream) —
      // that one. Any other fork's head is only its numbered branch.
      const remote =
        headForgeRepo === null ? listing : (listedBy.get(headForgeRepo) ?? null);
      if (remote === null) {
        if (pr.forge !== undefined) {
          claim(local, changeRequestLocalBranch(pr.forge, pr.number, listing), pr);
        }
        continue;
      }
      if (pr.headRefName === undefined) continue;
      claim(local, pr.headRefName, pr);
      let branches = remotes.get(remote);
      if (branches === undefined) {
        branches = new Map();
        remotes.set(remote, branches);
      }
      claim(branches, pr.headRefName, pr);
    }
    return { local, remotes };
  }

  private async refreshNow(
    repoId: string,
    generation: number,
    { ttl, force }: { ttl: number; force: boolean }
  ): Promise<boolean> {
    const path = this.repoPath(repoId);
    if (path === undefined) return false;
    const all = await this.forgeRemotes(path);
    // Git could not list the remotes: nothing to refresh, and nothing to
    // prune — an unanswered question is not "every remote is gone".
    if (all === null || !this.isCurrent(generation)) return false;
    const pruned = this.prune(repoId, all);
    const due = all.filter((remote) => {
      const key = listKey(repoId, remote.key);
      if (force) return true;
      return (
        !this.within(this.unasked.get(key), ttl) &&
        !this.within(this.lastFailure.get(key)?.at, ttl) &&
        !this.isFresh(repoId, remote.key, ttl)
      );
    });
    const ran = await Promise.all(
      due.map((remote) =>
        this.refreshRemote(repoId, remote, generation, remote === all[0])
      )
    );
    return pruned || ran.some(Boolean);
  }

  /**
   * `primary` is the checkout's first forge remote — `origin` when it has
   * one. Only its missing sign-in is a failure to report: the section is
   * there for it, while a mirror on a forge never connected simply is not
   * listed.
   */
  private async refreshRemote(
    repoId: string,
    remote: ForgeRemote,
    generation: number,
    primary: boolean
  ): Promise<boolean> {
    const key = listKey(repoId, remote.key);
    const { provider, repo } = remote.forge;
    const connection = await connectForge(provider, repo.host);
    if (!this.isCurrent(generation)) return false;
    if (connection === null) {
      if (!primary) {
        // Not a failure to report: a forge never connected is not a list
        // that stopped refreshing. It leaves `list()` until it can be asked.
        const changed = !this.unasked.has(key);
        this.unasked.set(key, this.now());
        this.lastFailure.delete(key);
        return changed;
      }
      return this.fail(
        key,
        `Not signed in to ${repo.host}. Run ${forgeSignInCommand(repo.kind, repo.host)}.`
      );
    }
    this.unasked.delete(key);
    let list: OpenPrList;
    try {
      list = await connection.fetchOpenPrs(repo);
    } catch (cause) {
      if (!this.isCurrent(generation)) return false;
      return this.fail(key, failureMessage(cause));
    }
    if (!this.isCurrent(generation)) return false;
    this.lastFailure.delete(key);
    this.write(repoId, remote, list);
    const path = this.repoPath(repoId);
    if (path !== undefined) await this.pruneViewRefs(path, remote, list);
    return true;
  }

  private fail(key: string, message: string): boolean {
    this.lastFailure.set(key, { at: this.now(), message });
    return true;
  }

  /**
   * Drop the rows and state of forge repositories no remote points at any
   * more — a remote removed or re-pointed — so search stops finding them.
   * True when anything went.
   */
  private prune(repoId: string, remotes: readonly ForgeRemote[]): boolean {
    const keep = new Set(remotes.map((remote) => remote.key));
    const gone = (
      this.db
        .prepare(
          `SELECT forge_repo FROM repo_open_pr_state WHERE repo_id = ?
           UNION
           SELECT DISTINCT forge_repo FROM repo_open_pr WHERE repo_id = ?`
        )
        .all(repoId, repoId) as { forge_repo: string }[]
    )
      .map((row) => row.forge_repo)
      .filter((forgeRepo) => !keep.has(forgeRepo));
    if (gone.length === 0) return false;
    const rows = this.db.prepare(
      "DELETE FROM repo_open_pr WHERE repo_id = ? AND forge_repo = ?"
    );
    const state = this.db.prepare(
      "DELETE FROM repo_open_pr_state WHERE repo_id = ? AND forge_repo = ?"
    );
    this.db.transaction(() => {
      for (const forgeRepo of gone) {
        rows.run(repoId, forgeRepo);
        state.run(repoId, forgeRepo);
        this.lastFailure.delete(listKey(repoId, forgeRepo));
        this.unasked.delete(listKey(repoId, forgeRepo));
      }
    })();
    return true;
  }

  /**
   * Store one forge repository's complete list by diff: rows that left are
   * deleted, rows that moved are rewritten, and untouched rows are not
   * written at all — each write re-indexes that PR's search row, and a busy
   * repository's list is mostly unchanged from one refresh to the next.
   */
  private write(repoId: string, remote: ForgeRemote, list: OpenPrList): void {
    if (this.db.prepare("SELECT 1 FROM repos WHERE id = ?").get(repoId) === undefined) {
      return;
    }
    const before = new Map(
      (
        this.db
          .prepare(
            `SELECT ${COLUMN_LIST} FROM repo_open_pr WHERE repo_id = ? AND forge_repo = ?`
          )
          .all(repoId, remote.key) as StoredRow[]
      ).map((row) => [Number(row.number), row] as const)
    );
    const next = new Map<number, StoredRow>();
    for (const item of list.items) {
      if (!next.has(item.number)) next.set(item.number, storedFromOpen(item));
    }
    const remove = this.db.prepare(
      "DELETE FROM repo_open_pr WHERE repo_id = ? AND forge_repo = ? AND number = ?"
    );
    const upsert = this.db.prepare(
      `INSERT INTO repo_open_pr (repo_id, forge_repo, ${WRITE_COLUMN_LIST})
       VALUES (@repo_id, @forge_repo, ${WRITE_COLUMN_PARAMS})
       ON CONFLICT(repo_id, forge_repo, number) DO UPDATE SET ${WRITE_COLUMN_UPDATES}`
    );
    this.db.transaction(() => {
      for (const number of before.keys()) {
        if (next.has(number)) continue;
        remove.run(repoId, remote.key, number);
      }
      for (const [number, row] of next) {
        if (sameRow(before.get(number), row)) continue;
        const headRepoPath = row.head_repo_path;
        upsert.run({
          repo_id: repoId,
          forge_repo: remote.key,
          head_forge_repo:
            typeof headRepoPath === "string"
              ? forgeRepoKey(remote.forge.repo.host, headRepoPath)
              : null,
          ...row
        });
      }
      this.db
        .prepare(
          `INSERT INTO repo_open_pr_state (repo_id, forge_repo, remote, fetched_at, truncated)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(repo_id, forge_repo) DO UPDATE SET
             remote = excluded.remote,
             fetched_at = excluded.fetched_at,
             truncated = excluded.truncated`
        )
        .run(repoId, remote.key, remote.name, this.now(), list.truncated ? 1 : 0);
    })();
  }

  private cachedOpen(
    repoId: string
  ): { forgeRepo: string; headForgeRepo: string | null; pr: OpenChangeRequest }[] {
    return (
      this.db
        .prepare(
          `SELECT p.forge_repo AS forge_repo, p.head_forge_repo AS head_forge_repo,
                  ${openPrSelect("p")} FROM repo_open_pr p
            WHERE p.repo_id = ?
            ORDER BY COALESCE(p.updated_at, p.opened_at, 0) DESC, p.number DESC`
        )
        .all(repoId) as (Record<string, unknown> & {
        forge_repo: string;
        head_forge_repo: string | null;
      })[]
    ).flatMap((row) => {
      const pr = openPrFromRow(row);
      return pr === undefined
        ? []
        : [{ forgeRepo: row.forge_repo, headForgeRepo: row.head_forge_repo, pr }];
    });
  }

  /**
   * Whose #`number` a lookup means: `forgeRepo`'s when given (null when no
   * remote points there any more), else the first remote whose list holds
   * it, else the first remote (`origin`).
   */
  private targetFor(
    repoId: string,
    number: number,
    remotes: readonly ForgeRemote[],
    forgeRepo: string | undefined
  ): ForgeRemote | null {
    if (forgeRepo !== undefined) {
      return remotes.find((remote) => remote.key === forgeRepo) ?? null;
    }
    const listing = new Set(
      (
        this.db
          .prepare("SELECT forge_repo FROM repo_open_pr WHERE repo_id = ? AND number = ?")
          .all(repoId, number) as { forge_repo: string }[]
      ).map((row) => row.forge_repo)
    );
    return remotes.find((remote) => listing.has(remote.key)) ?? remotes[0] ?? null;
  }

  private async findByNumber(
    repoId: string,
    number: number,
    remote: ForgeRemote
  ): Promise<OpenChangeRequest | null> {
    const open = this.db
      .prepare(
        `SELECT ${openPrSelect("p")} FROM repo_open_pr p
          WHERE p.repo_id = ? AND p.forge_repo = ? AND p.number = ?`
      )
      .get(repoId, remote.key, number) as Record<string, unknown> | undefined;
    const cached = open === undefined ? undefined : openPrFromRow(open);
    if (cached !== undefined) return cached;
    const key = `${listKey(repoId, remote.key)}\n${number}`;
    const memo = this.lookups.get(key);
    const now = this.now();
    if (memo !== undefined && memo.at <= now && memo.at > now - LOOKUP_TTL_MS) {
      return memo.pr;
    }
    const generation = this.writeGeneration;
    const { provider, repo } = remote.forge;
    const connection = await connectForge(provider, repo.host);
    if (connection === null) return null;
    let answer: Map<number, PrSummary | null>;
    try {
      answer = await connection.fetchPrsByNumbers(repo, [number]);
    } catch {
      return null;
    }
    // An omitted number is "never asked", not "does not exist" — do not
    // remember it.
    if (!answer.has(number)) return null;
    const pr = answer.get(number) ?? null;
    if (this.isCurrent(generation)) this.lookups.set(key, { at: now, pr });
    return pr;
  }

  private async checkoutRefs(
    repoId: string,
    path: string,
    remotes: readonly ForgeRemote[]
  ): Promise<CheckoutRefs> {
    const worktrees = this.worktreeBranches(repoId);
    const out = await this.git(
      ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
      path
    );
    return checkoutRefsFromRefnames(
      out.ok && out.value.exitCode === 0 ? out.value.stdout : "",
      worktrees,
      remotes.flatMap((remote) => remote.names)
    );
  }

  /** A forge-supplied name goes into a refspec only once git accepts it as a branch. */
  private async isBranchName(path: string, name: string): Promise<boolean> {
    if (name.startsWith("-")) return false;
    const out = await this.git(["check-ref-format", "--branch", name], path);
    return out.ok && out.value.exitCode === 0;
  }

  private repoPath(repoId: string): string | undefined {
    return (
      this.db.prepare("SELECT path FROM repos WHERE id = ?").get(repoId) as
        | { path: string }
        | undefined
    )?.path;
  }

  /**
   * Every forge repository this checkout has a remote on, `origin`'s first,
   * each once; null when git could not list the remotes. Resolved each time,
   * not cached: Settings → Forges can claim a host later.
   */
  private async forgeRemotes(repoPath: string): Promise<ForgeRemote[] | null> {
    const urls = await this.remoteUrlsOf(repoPath);
    if (urls === null) return null;
    const ordered = [
      ...urls.filter((remote) => remote.name === "origin"),
      ...urls.filter((remote) => remote.name !== "origin")
    ];
    const out = new Map<string, ForgeRemote>();
    for (const { name, url } of ordered) {
      const forge = this.resolveForge(url);
      if (forge === null) continue;
      const key = forgeRepoKey(forge.repo.host, forge.repo.path);
      const seen = out.get(key);
      if (seen === undefined) out.set(key, { name, names: [name], key, forge });
      else seen.names.push(name);
    }
    return [...out.values()];
  }

  /**
   * Each remote's fetch URL, asked of git only when `.git/config` has changed
   * since the last answer — every way a remote is added, renamed or
   * re-pointed, in the app or a terminal, rewrites that file. A repository
   * whose config cannot be stat'ed is asked every time.
   *
   * `git remote -v`, not the raw `remote.*.url` values: it applies
   * `url.<base>.insteadOf`, as `git remote get-url` does, so an aliased
   * remote (`gh:acme/orbit`) still names its forge. Null when git could not
   * answer — never cached, and never read as "no remotes", because a refresh
   * drops the lists of remotes that are gone.
   */
  private async remoteUrlsOf(
    repoPath: string
  ): Promise<{ name: string; url: string }[] | null> {
    const stamp = await configStamp(repoPath);
    const cached = this.remoteUrls.get(repoPath);
    if (stamp !== null && cached?.stamp === stamp) return cached.urls;
    const out = await this.git(["remote", "-v"], repoPath);
    if (!out.ok || out.value.exitCode !== 0) return null;
    const urls = parseRemoteUrls(out.value.stdout);
    if (stamp !== null) this.remoteUrls.set(repoPath, { stamp, urls });
    return urls;
  }

  /**
   * `CheckoutRefs` from the branch index the indexer keeps for ⌘K — the same
   * answer search gives — rather than a `for-each-ref` per read. Local
   * branches are `local_branches` plus every worktree's branch (the index
   * drops a branch once a worktree holds it); each remote's are
   * `remote_branches`, read only for the cached heads' names — an upstream
   * can carry tens of thousands of branches, and this runs on every expand.
   */
  private indexedCheckoutRefs(repoId: string): CheckoutRefs {
    const worktrees = this.worktreeBranches(repoId);
    const local = new Set(
      (
        this.db
          .prepare("SELECT name FROM local_branches WHERE repo_id = ?")
          .all(repoId) as { name: string }[]
      ).map((row) => row.name)
    );
    for (const branch of worktrees.keys()) local.add(branch);
    const remotes = new Map<string, Map<string, string>>();
    for (const row of this.db
      .prepare(
        `SELECT remote_name, name, full_name FROM remote_branches
          WHERE repo_id = ?
            AND name IN (SELECT head_ref FROM repo_open_pr WHERE repo_id = ?)`
      )
      .all(repoId, repoId) as { remote_name: string; name: string; full_name: string }[]) {
      let branches = remotes.get(row.remote_name);
      if (branches === undefined) {
        branches = new Map();
        remotes.set(row.remote_name, branches);
      }
      branches.set(row.name, row.full_name);
    }
    return { worktrees, local, remotes };
  }

  private worktreeBranches(repoId: string): Map<string, string> {
    return new Map(
      (
        this.db
          .prepare(
            "SELECT id, branch FROM worktrees WHERE repo_id = ? AND missing = 0"
          )
          .all(repoId) as { id: string; branch: string }[]
      ).map((row) => [row.branch, row.id] as const)
    );
  }

  private isFresh(repoId: string, forgeRepo: string, ttlMs: number): boolean {
    const row = this.db
      .prepare(
        "SELECT fetched_at FROM repo_open_pr_state WHERE repo_id = ? AND forge_repo = ?"
      )
      .get(repoId, forgeRepo) as { fetched_at: number } | undefined;
    if (row === undefined) return false;
    const now = this.now();
    // A stamp from the future is a backward clock step, not a fresh list.
    return row.fetched_at <= now && row.fetched_at > now - ttlMs;
  }

  /** Whether `at` (a failure, a missing sign-in) is recent enough to wait out. */
  private within(at: number | undefined, ttlMs: number): boolean {
    if (at === undefined) return false;
    const now = this.now();
    return at <= now && at > now - ttlMs;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.writeGeneration;
  }
}

/** The in-memory key for one repository's list from one forge repository. */
function listKey(repoId: string, forgeRepo: string): string {
  return `${repoId}\n${forgeRepo}`;
}

/**
 * Which remotes an entry listed by `remote` involves: the listing remote,
 * and the one whose repository holds the head — itself for a same-repository
 * head, another remote when a fork's head is in a repository this checkout
 * also has (your fork, for a PR you sent to the original), else none.
 */
function placeFor(
  pr: OpenChangeRequest,
  remote: ForgeRemote,
  all: readonly ForgeRemote[]
): ChangeRequestPlace {
  if (pr.headRepoPath === undefined) {
    return { remote: remote.name, headRemote: remote.name };
  }
  const head = forgeRepoKey(remote.forge.repo.host, pr.headRepoPath);
  return {
    remote: remote.name,
    headRemote: all.find((candidate) => candidate.key === head)?.name ?? null
  };
}

/** `git remote -v` (`name<TAB>url (fetch)`), the fetch URL of each remote. */
function parseRemoteUrls(stdout: string): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0 || !line.endsWith(" (fetch)")) continue;
    const name = line.slice(0, tab);
    const url = line.slice(tab + 1, -" (fetch)".length).trim();
    if (url === "" || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, url });
  }
  return out;
}

/** The config file's identity, or null when it cannot be read. */
async function configStamp(repoPath: string): Promise<string | null> {
  try {
    const info = await stat(join(repoPath, ".git", "config"));
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

/** A forge error as one line for the sidebar: its first line, capped. */
function failureMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const line = text.split("\n")[0]?.trim() ?? "";
  if (line === "") return "The forge did not answer.";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function invalidHead(name: string): Result<ChangeRequestLocation> {
  return err({
    kind: "validation",
    code: "invalid_branch",
    message: `"${name}" is not a branch name git accepts.`
  });
}

/** `git log --format=%H%x1f%an%x1f%at%x1f%s`, one commit per line. */
export function parseViewLog(stdout: string): ChangeRequestViewCommit[] {
  const out: ChangeRequestViewCommit[] = [];
  for (const line of stdout.split("\n")) {
    const [hash = "", author = "", at = "", ...subject] = line.split("\x1f");
    if (!/^[0-9a-f]{7,64}$/i.test(hash)) continue;
    const seconds = Number.parseInt(at, 10);
    out.push({
      hash,
      author,
      at: Number.isFinite(seconds) ? seconds * 1000 : 0,
      subject: subject.join("\x1f")
    });
  }
  return out;
}

function storedFromOpen(pr: OpenChangeRequest): StoredRow {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    is_draft: pr.isDraft ? 1 : 0,
    check_state: pr.checkState ?? null,
    checks_still_running:
      pr.checksStillRunning === undefined ? null : Number(pr.checksStillRunning),
    merge_state: pr.mergeState ?? null,
    forge: pr.forge ?? null,
    host: pr.host ?? null,
    repo_path: pr.repoPath ?? null,
    head_ref: pr.headRefName ?? null,
    base_ref: pr.baseRefName ?? null,
    head_oid: pr.headOid ?? null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changed_files: pr.changedFiles ?? null,
    commit_count: pr.commitCount ?? null,
    opened_at: pr.createdAt ?? null,
    merged_at: pr.mergedAt ?? null,
    closed_at: pr.closedAt ?? null,
    author: pr.author ?? null,
    head_repo_path: pr.headRepoPath ?? null,
    updated_at: pr.updatedAt ?? null
  };
}

function sameRow(before: StoredRow | undefined, next: StoredRow): boolean {
  if (before === undefined) return false;
  return OPEN_PR_COLUMNS.every((column) => before[column] === next[column]);
}
