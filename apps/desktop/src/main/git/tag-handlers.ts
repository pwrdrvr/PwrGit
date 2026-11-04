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
  planRemoteTag,
  resolveTagTarget
} from "./git-service";
import { tagSourcesFor } from "./tag-sources";

type RepoRow = {
  path: string;
  profile_id: string;
  email: string;
  author_name: string | null;
};

const notFound = {
  kind: "repo" as const,
  code: "not_found",
  message: "repo not found"
};

export function registerTagHandlers(bus: CommandBus, db: DB): void {
  const repoOf = (repoId: string): RepoRow | undefined =>
    db
      .prepare(
        `SELECT r.path AS path, r.profile_id AS profile_id,
                p.email AS email, p.author_name AS author_name
         FROM repos r
         JOIN profiles p ON p.id = r.profile_id
         WHERE r.id = ?`
      )
      .get(repoId) as RepoRow | undefined;

  const tagSources = tagSourcesFor(db);
  /** Local tags moved: the sidebar's tag rows and the graph's chips. */
  const tagsMoved = (repoId: string, profileId: string): void => {
    emitEvent("repo:changed", { profileId, repoIds: [repoId] });
    emitEvent("graph:changed", { repoId });
  };

  bus.register("repo:tagStatus", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) return err(notFound);
    const page = await tagSources.statusPage(execGit, req.repoId, repo.path, {
      ...(req.filter === undefined ? {} : { filter: req.filter }),
      ...(req.query === undefined ? {} : { query: req.query }),
      ...(req.offset === undefined ? {} : { offset: req.offset }),
      ...(req.limit === undefined ? {} : { limit: req.limit })
    });
    if (!page.ok) return page;
    const { differsChanged, ...value } = page.value;
    // The sidebar's "N tags differ" line reads the stored count.
    if (differsChanged) {
      emitEvent("repo:changed", { profileId: repo.profile_id, repoIds: [req.repoId] });
    }
    return ok(value);
  });

  bus.register("tag:setPrimaryRemote", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) return err(notFound);
    const source = await tagSources.source(execGit, req.repoId, repo.path);
    if (!source.ok) return source;
    if (!source.value.state.remotes.includes(req.remote)) {
      return err({ kind: "repo", code: "invalid_remote", message: `Not a configured remote: ${req.remote}` });
    }
    tagSources.setPrimary(req.repoId, req.remote);
    logMain("info", "tag", `published tag source for ${repo.path} is now ${req.remote}`);
    const recount = await tagSources.recountPublisher(execGit, req.repoId, repo.path);
    if (recount.ok) {
      emitEvent("repo:changed", { profileId: repo.profile_id, repoIds: [req.repoId] });
    }
    const next = await tagSources.source(execGit, req.repoId, repo.path);
    return next.ok ? ok(next.value.state) : next;
  });

  bus.register("tag:keepLocal", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) return err(notFound);
    tagSources.keepLocal(req.repoId, req);
    logMain(
      "info",
      "tag",
      `${req.keep ? "keeping" : "no longer keeping"} local ${req.name} ${req.localObjectId.slice(0, 12)} over ${req.remote} ${req.remoteObjectId.slice(0, 12)}`
    );
    const recount = await tagSources.recountPublisher(execGit, req.repoId, repo.path);
    if (recount.ok && recount.value) {
      emitEvent("repo:changed", { profileId: repo.profile_id, repoIds: [req.repoId] });
    }
    return ok(null);
  });

  bus.register("tag:details", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) return err(notFound);
    return tagSources.details(execGit, req.repoId, repo.path, req.name);
  });

  bus.register("tag:restoreReplaced", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) return err(notFound);
    const restored = await tagSources.restore(execGit, req.repoId, repo.path, req);
    if (!restored.ok) return restored;
    logMain(
      "info",
      "tag",
      `restored ${req.name} to ${restored.value.objectId} from ${req.ref}${restored.value.replacedRef === null ? "" : `; previous value kept as ${restored.value.replacedRef}`}`
    );
    tagsMoved(req.repoId, repo.profile_id);
    return restored;
  });

  bus.register("tag:resolveCommit", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) return err(notFound);
    return resolveTagTarget(execGit, repo.path, req.revision);
  });

  bus.register("tag:create", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) return err(notFound);
    const created = await createTagAt(
      execGit,
      repo.path,
      {
        name: req.name,
        targetCommit: req.targetCommit,
        kind: req.kind,
        ...(req.message === undefined ? {} : { message: req.message })
      },
      {
        email: repo.email,
        ...(repo.author_name === null ? {} : { name: repo.author_name })
      }
    );
    if (!created.ok) return created;
    logMain(
      "info",
      "tag",
      `created ${created.value.kind} tag ${created.value.name} at ${created.value.targetId}`
    );
    emitEvent("repo:changed", {
      profileId: repo.profile_id,
      repoIds: [req.repoId]
    });
    // The lineage graph chips one prominent tag per commit and caches that map
    // with the lanes for LANE_TTL_MS. `repo:changed` only reaches the sidebar,
    // so without this the tag the user just made at a visible commit stays
    // invisible in the graph for up to 30 seconds.
    emitEvent("graph:changed", { repoId: req.repoId });
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
    emitEvent("repo:changed", {
      profileId: repo.profile_id,
      repoIds: [req.repoId]
    });
    // Same reason as tag:create — a deleted tag must lose its chip too.
    emitEvent("graph:changed", { repoId: req.repoId });
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
