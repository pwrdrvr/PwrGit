import { err, ok, type Repo } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { limitConcurrency } from "../util/map-limit";
import type { StackReader } from "./stack-reader";

export function registerStackReadHandlers(
  bus: CommandBus,
  findRepo: (id: string) => Repo | null,
  reader: Pick<StackReader, "list">,
): void {
  const list = limitConcurrency((repo: Repo) => reader.list(repo), 4);
  bus.register("stack:list", async ({ repoId, profileId }) => {
    const repo = findRepo(repoId);
    if (!repo || repo.profileId !== profileId) {
      return err({ kind: "validation", code: "unknown_repository", message: "Repository is outside this profile" });
    }
    return ok(await list(repo));
  });
}
