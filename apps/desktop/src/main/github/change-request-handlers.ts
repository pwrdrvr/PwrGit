import { ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { OpenListTrigger, OpenPrService } from "./open-pr-service";

/**
 * The open change-request list over the bus: read it, look one up by number,
 * and bring one's head into the checkout.
 *
 * Every read answers from main's cache at once. `refresh` re-lists in the
 * background, and `pr:openChanged` tells the renderer to re-read — a list
 * refresh walks pages, and no dialog should wait on one to paint.
 */
export function registerChangeRequestHandlers(
  bus: CommandBus,
  openPrs: OpenPrService,
  deps: {
    /** A fetch added refs: re-index them so ⌘K and the sidebar see them. */
    onHeadFetched?: (repoId: string) => Promise<void>;
  } = {}
): { refreshInBackground: (repoId: string, trigger: OpenListTrigger) => void } {
  const refreshInBackground = (repoId: string, trigger: OpenListTrigger): void => {
    void openPrs
      .refresh(repoId, { trigger })
      .then((changed) => {
        if (changed) emitEvent("pr:openChanged", { repoId });
      })
      .catch((cause: unknown) => {
        logMain("warn", "pr", `open list refresh failed for ${repoId}`, cause);
      });
  };

  bus.register("pr:openList", async (req) => {
    if (req.refresh === true) refreshInBackground(req.repoId, "user");
    return ok(await openPrs.list(req.repoId));
  });

  bus.register("pr:lookup", async (req) =>
    ok(await openPrs.lookup(req.repoId, req.number))
  );

  bus.register("pr:fetchHead", async (req) => {
    const fetched = await openPrs.fetchHead(req.repoId, req.number);
    if (!fetched.ok) return fetched;
    try {
      await deps.onHeadFetched?.(req.repoId);
    } catch (cause) {
      logMain("warn", "pr", `re-index after head fetch failed for ${req.repoId}`, cause);
    }
    // Where the head lives moved, and every open list in every window says so.
    emitEvent("pr:openChanged", { repoId: req.repoId });
    return fetched;
  });

  return { refreshInBackground };
}
