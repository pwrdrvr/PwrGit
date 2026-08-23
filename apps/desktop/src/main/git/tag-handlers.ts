import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import {
  applyRemoteTagPlan,
  createTagAt,
  deleteLocalTag,
  listTagPage,
  planRemoteTag
} from "./git-service";

type RepoRow = { path: string; profile_id: string };

const notFound = {
  kind: "repo" as const,
  code: "not_found",
  message: "repo not found"
};

export function registerTagHandlers(bus: CommandBus, db: DB): void {
  const repoOf = (repoId: string): RepoRow | undefined =>
    db
      .prepare("SELECT path, profile_id FROM repos WHERE id = ?")
      .get(repoId) as RepoRow | undefined;

  bus.register("repo:tags", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) return err(notFound);
    return listTagPage(execGit, repo.path, {
      ...(req.query === undefined ? {} : { query: req.query }),
      ...(req.offset === undefined ? {} : { offset: req.offset }),
      ...(req.limit === undefined ? {} : { limit: req.limit })
    });
  });

  bus.register("tag:create", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) return err(notFound);
    const created = await createTagAt(execGit, repo.path, {
      name: req.name,
      targetCommit: req.targetCommit,
      kind: req.kind,
      ...(req.message === undefined ? {} : { message: req.message })
    });
    if (!created.ok) return created;
    logMain(
      "info",
      "tag",
      `created ${created.value.kind} tag ${created.value.name} at ${created.value.targetId}`
    );
    emitEvent("repo:changed", { profileId: repo.profile_id });
    return created;
  });

  bus.register("tag:deleteLocal", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) return err(notFound);
    const deleted = await deleteLocalTag(
      execGit,
      repo.path,
      req.name,
      req.expectedObjectId
    );
    if (!deleted.ok) return deleted;
    logMain("info", "tag", `deleted local tag ${req.name}`);
    emitEvent("repo:changed", { profileId: repo.profile_id });
    return ok(null);
  });

  bus.register("tag:planRemote", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) return err(notFound);
    return planRemoteTag(execGit, repo.path, req);
  });

  bus.register("tag:applyRemote", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) return err(notFound);
    const applied = await applyRemoteTagPlan(execGit, repo.path, req.plan);
    if (!applied.ok) return applied;
    logMain(
      "info",
      "tag",
      `${applied.value.outcome} ${applied.value.remote}/${applied.value.tagName}`
    );
    return applied;
  });
}
