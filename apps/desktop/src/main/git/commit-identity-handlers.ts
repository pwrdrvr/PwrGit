import {
  err,
  ok,
  type CommitIdentityInspection,
  type FolderIdentityReport,
  type MachineGitIdentity
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { logMain } from "../logs";
import {
  inspectCommitIdentity,
  resolveMachineIdentity,
  writeGlobalIdentity
} from "./commit-identity";
import type { GitExec } from "./dugite";
import {
  applyFolderSync,
  clearRepoOverride,
  inspectFolderIdentity,
  planFolderSync,
  planIsApplied,
  type FolderProfileRow,
  type FolderRepoRow
} from "./folder-identity";
import { visibleRepoSql } from "./hidden-repos";
import { worktreeMissingError } from "./worktree-liveness";

export type CommitIdentityHandlerDependencies = {
  git: GitExec;
  /** General › "Notify when Git outside PwrGit has no identity". */
  reminderEnabled: () => boolean;
  /** Whether a window that once claimed the notice still exists. */
  windowAlive: (webContentsId: number) => boolean;
  emitChanged: () => void;
  /** Settings › Profiles › By folder, read and written by main only. */
  folderSyncEnabled: () => boolean;
  setFolderSyncEnabled: (enabled: boolean) => void;
};

/** What the profile-change hook calls; `index.ts` wires it to `profile:changed`. */
export type CommitIdentityHandles = {
  /** Re-apply the folder includes when the switch is on and the config no
   *  longer says what the profiles do. Serialized; a no-op otherwise. */
  resyncFolders: () => Promise<void>;
};

type InspectionRow = {
  path: string;
  missing: number;
  name: string;
  email: string;
  author_name: string | null;
};

/**
 * `identity:*` — the commit footer's identity, Git's identity outside
 * PwrGit, the launch notice, and the one config write PwrGit makes.
 *
 * The launch notice reports a machine fact, so it belongs to one window: the
 * first that asks owns it until that window closes or the notice is
 * dismissed, and every other window is told no. Dismissal lasts for this
 * launch; Settings keeps reporting the state regardless.
 */
export function registerCommitIdentityHandlers(
  bus: CommandBus,
  db: DB,
  deps: CommitIdentityHandlerDependencies
): CommitIdentityHandles {
  const git = deps.git;
  const inFlight = new Map<string, Promise<CommitIdentityInspection>>();
  let noticeOwner: number | null = null;
  let noticeDismissed = false;

  const rowFor = (worktreeId: string): InspectionRow | undefined =>
    db
      .prepare(
        `SELECT w.path AS path, w.missing AS missing, p.name AS name,
                p.email AS email, p.author_name AS author_name
         FROM worktrees w
         JOIN repos r ON r.id = w.repo_id
         JOIN profiles p ON p.id = r.profile_id
         WHERE w.id = ?`
      )
      .get(worktreeId) as InspectionRow | undefined;

  bus.register("identity:inspect", async (req) => {
    const row = rowFor(req.worktreeId);
    if (row === undefined) {
      return err({ kind: "repo", code: "not_found", message: "Worktree not found." });
    }
    if (row.missing === 1) return err(worktreeMissingError(row.path));
    // One inspection per checkout at a time: the footer asks on select, on
    // focus and after every commit, and a renderer loop must not turn each
    // ask into seven more Git processes (git/AGENTS.md, "bound it on this
    // side"). The key includes the profile's identity, so an edit is never
    // answered with a resolution of the old values.
    const key = JSON.stringify([req.worktreeId, row.email, row.author_name]);
    let pending = inFlight.get(key);
    if (pending === undefined) {
      pending = inspectCommitIdentity(git, row.path, req.worktreeId, {
        name: row.name,
        email: row.email,
        authorName: row.author_name
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return ok(await pending);
  });

  const machine = async (
    claimNotice: boolean,
    webContentsId: number | undefined
  ): Promise<MachineGitIdentity> => {
    const resolved = await resolveMachineIdentity(git);
    const unset = resolved.outside.kind !== "configured";
    if (!unset) noticeOwner = null;
    const ownerGone = noticeOwner !== null && !deps.windowAlive(noticeOwner);
    if (ownerGone) noticeOwner = null;
    const notice =
      claimNotice &&
      webContentsId !== undefined &&
      unset &&
      !noticeDismissed &&
      deps.reminderEnabled() &&
      (noticeOwner === null || noticeOwner === webContentsId);
    if (notice) noticeOwner = webContentsId;
    return { ...resolved, notice };
  };

  bus.register("identity:machine", async (req, ctx) =>
    ok(await machine(req.claimNotice === true, ctx.webContentsId))
  );

  bus.register("identity:dismissNotice", () => {
    noticeDismissed = true;
    noticeOwner = null;
    deps.emitChanged();
    return ok(null);
  });

  bus.register("identity:writeGlobal", async (req, ctx) => {
    const written = await writeGlobalIdentity(git, req.name, req.email);
    if (!written.ok) return written;
    logMain("info", "identity", "wrote user.name and user.email with git config --global");
    deps.emitChanged();
    return ok(await machine(false, ctx.webContentsId));
  });

  // ---- Identity by folder -------------------------------------------------

  const folderProfiles = (): FolderProfileRow[] =>
    (
      db
        .prepare(
          `SELECT id, name, mono, email, author_name, roots FROM profiles
           ORDER BY sort_order, created_at`
        )
        .all() as {
        id: string;
        name: string;
        mono: string;
        email: string;
        author_name: string | null;
        roots: string;
      }[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      mono: row.mono,
      email: row.email,
      authorName: row.author_name,
      roots: parseRoots(row.roots)
    }));

  const folderRepos = (): FolderRepoRow[] =>
    db
      .prepare(
        `SELECT r.id AS id, r.profile_id AS profileId, r.name AS name, r.path AS path
         FROM repos r WHERE ${visibleRepoSql("r")}`
      )
      .all() as FolderRepoRow[];

  // One read per scope at a time: Settings and every window's popup can ask
  // together, and each read is a Git process per repository.
  const folderReads = new Map<string, Promise<FolderIdentityReport>>();
  const readFolders = (profileId?: string): Promise<FolderIdentityReport> => {
    const key = profileId ?? "*";
    let pending = folderReads.get(key);
    if (pending === undefined) {
      pending = inspectFolderIdentity(
        { git },
        {
          enabled: deps.folderSyncEnabled(),
          profiles: folderProfiles(),
          repos: folderRepos(),
          ...(profileId === undefined ? {} : { profileId })
        }
      ).finally(() => folderReads.delete(key));
      folderReads.set(key, pending);
    }
    return pending;
  };

  bus.register("identity:folders", async (req) => ok(await readFolders(req.profileId)));

  bus.register("identity:folderPlan", async (req) =>
    ok(await planFolderSync({ git }, folderProfiles(), req.enabled))
  );

  // Every write goes through this chain, so a switch flip and a profile edit
  // never interleave their unset/add sequences in the same file.
  let writes: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = writes.then(work, work);
    writes = next.catch(() => undefined);
    return next;
  };

  bus.register("identity:setFolderSync", (req) =>
    serialized(async () => {
      const plan = await planFolderSync({ git }, folderProfiles(), req.enabled);
      const applied = await applyFolderSync({ git }, plan);
      if (!applied.ok) return applied;
      deps.setFolderSyncEnabled(req.enabled);
      logMain(
        "info",
        "identity",
        req.enabled
          ? `wrote ${plan.add.length} includeIf entries and ${plan.files.length} include files`
          : `removed ${plan.remove.length} includeIf entries and ${plan.deleteFiles.length} include files`
      );
      deps.emitChanged();
      return ok(await readFolders());
    })
  );

  bus.register("identity:clearRepoOverride", async (req) => {
    const repo = folderRepos().find((row) => row.id === req.repoId);
    const profile = folderProfiles().find((row) => row.id === repo?.profileId);
    if (repo === undefined || profile === undefined) {
      return err({ kind: "repo", code: "not_found", message: "Repository not found." });
    }
    const cleared = await clearRepoOverride(git, repo.path, profile);
    if (!cleared.ok) return cleared;
    logMain("info", "identity", `removed a repository's own identity from ${repo.name}`);
    deps.emitChanged();
    return ok(await readFolders());
  });

  const resyncFolders = (): Promise<void> =>
    serialized(async () => {
      if (!deps.folderSyncEnabled()) return;
      const plan = await planFolderSync({ git }, folderProfiles(), true);
      if (await planIsApplied({ git }, plan)) return;
      const applied = await applyFolderSync({ git }, plan);
      if (!applied.ok) {
        logMain("warn", "identity", `couldn’t update the folder includes: ${applied.error.message}`);
        return;
      }
      logMain("info", "identity", `updated ${plan.add.length} includeIf entries after a profile change`);
      deps.emitChanged();
    });

  return { resyncFolders };
}

function parseRoots(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((root): root is string => typeof root === "string") : [];
  } catch {
    return [];
  }
}
