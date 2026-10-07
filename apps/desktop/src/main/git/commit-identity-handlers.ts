import { err, ok, type CommitIdentityInspection, type MachineGitIdentity } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { logMain } from "../logs";
import {
  inspectCommitIdentity,
  resolveMachineIdentity,
  writeGlobalIdentity
} from "./commit-identity";
import type { GitExec } from "./dugite";
import { worktreeMissingError } from "./worktree-liveness";

export type CommitIdentityHandlerDependencies = {
  git: GitExec;
  /** General › "Notify when Git outside PwrGit has no identity". */
  reminderEnabled: () => boolean;
  /** Whether a window that once claimed the notice still exists. */
  windowAlive: (webContentsId: number) => boolean;
  emitChanged: () => void;
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
): void {
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
}
