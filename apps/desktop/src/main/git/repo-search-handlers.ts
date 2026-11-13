import { homedir } from "node:os";
import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { NewRootService } from "../profiles/new-root";
import type { ProfileService } from "../profiles/profile-service";
import type { RepoIndexer } from "./repo-indexer";
import { searchHomeForRepositories } from "./repo-search";

type LiveSearch = {
  searchId: string;
  /** Superseded or window closed: answer nothing. */
  cancel: AbortController;
  /** The user pressed Stop: answer with what was found. */
  stop: AbortController;
};

/**
 * Find my repositories and the folders it may create.
 *
 * Main decides how many searches run: one per window. A second request from
 * the same window supersedes the first (answered `superseded`), so a renderer
 * that asked in a loop cannot stack walks of the home folder. A closed window
 * cancels its search.
 */
export function registerRepoSearchHandlers(
  bus: CommandBus,
  deps: {
    profiles: ProfileService;
    indexer: RepoIndexer;
    newRoots: NewRootService;
    home?: () => string;
    platform?: NodeJS.Platform;
    /** The walk; tests substitute one they can hold open. */
    search?: typeof searchHomeForRepositories;
  }
): { releaseWebContents: (webContentsId: number) => void } {
  const { profiles, indexer, newRoots } = deps;
  const home = deps.home ?? homedir;
  const platform = deps.platform ?? process.platform;
  const searchHome = deps.search ?? searchHomeForRepositories;
  const live = new Map<number | "local", LiveSearch>();

  bus.register("repo:searchHome", async (req, ctx) => {
    const owner = ctx.webContentsId ?? "local";
    live.get(owner)?.cancel.abort();
    const search: LiveSearch = {
      searchId: req.searchId,
      cancel: new AbortController(),
      stop: new AbortController()
    };
    live.set(owner, search);
    const all = profiles.list();
    const own = all.find((p) => p.id === req.profileId);
    try {
      const result = await searchHome({
        home: home(),
        platform,
        includeProtected: req.includeProtected,
        signal: search.cancel.signal,
        stop: search.stop.signal,
        roots: {
          own: own?.roots ?? [],
          others: all.filter((p) => p.id !== req.profileId)
        },
        onProgress: (progress) => {
          emitEvent("repo:searchProgress", {
            searchId: req.searchId,
            profileId: req.profileId,
            ...progress
          });
        }
      });
      logMain(
        "info",
        "repo",
        `home search: ${result.foldersOpened} folders opened, ${result.folders.length} proposed` +
          (result.stoppedEarly === null ? "" : `, stopped early (${result.stoppedEarly})`)
      );
      return ok(result);
    } catch (cause) {
      if (search.cancel.signal.aborted) {
        return err({
          kind: "validation",
          code: "superseded",
          message: "A newer search replaced this one."
        });
      }
      return err({
        kind: "repo",
        code: "home_unreadable",
        message: `Couldn’t look in your home folder: ${cause instanceof Error ? cause.message : String(cause)}`
      });
    } finally {
      if (live.get(owner) === search) live.delete(owner);
    }
  });

  bus.register("repo:stopSearch", (req) => {
    for (const search of live.values()) {
      if (search.searchId === req.searchId) search.stop.abort();
    }
    return ok(null);
  });

  bus.register("profile:suggestedRoots", async () => ok(await newRoots.suggested()));

  bus.register("profile:createRoot", async (req) => {
    const attached = await newRoots.attach(req.profileId, req.root);
    if (!attached.ok) return attached;
    const profile = profiles.get(req.profileId);
    if (profile === null) {
      await attached.value.undo();
      return err({ kind: "profile", code: "not_found", message: `No profile "${req.profileId}"` });
    }
    const repos = await indexer.rescanProfile(profile);
    emitEvent("profile:changed", profiles.snapshot());
    emitEvent("repo:changed", { profileId: profile.id });
    return ok({ path: attached.value.path, created: attached.value.created, repos });
  });

  return {
    releaseWebContents(webContentsId) {
      live.get(webContentsId)?.cancel.abort();
      live.delete(webContentsId);
    }
  };
}
