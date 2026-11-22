import { err, ok, type Repo } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { StackReader } from "./stack-reader";

export function registerStackReadHandlers(
  bus: CommandBus,
  findRepo: (id: string) => Repo | null,
  reader: Pick<StackReader, "list">,
): void {
  bus.register("stack:list", async ({ repoId, profileId }) => {
    const repo = findRepo(repoId);
    if (!repo || repo.profileId !== profileId) {
      return err({ kind: "validation", code: "unknown_repository", message: "Repository is outside this profile" });
    }
    return ok(await reader.list(repo));
  });
}
