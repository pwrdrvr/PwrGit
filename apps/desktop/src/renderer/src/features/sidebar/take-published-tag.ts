import type { RemoteTagValue } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { confirmDialog } from "../shell/dialogs";

/** The local side of a Take: what the confirm names and the lease expects. */
export type TakeLocal = {
  objectId: string;
  targetId: string;
  kind: "lightweight" | "annotated";
};

/** Whether the published commit is here: from the reader, else `tag:details`. */
async function publishedAvailable(repoId: string, name: string, published: RemoteTagValue): Promise<boolean> {
  if (published.available !== undefined) return published.available;
  const details = await dispatch("tag:details", { repoId, name });
  if (!details.ok) return false;
  const value = details.value.remotes.find((entry) => entry.remote === published.remote)?.value;
  return value?.objectId === published.objectId && value.available === true;
}

/**
 * Take the published value of one tag (a tag that differs) or download it
 * (published only): one confirm, then `tag:adoptRemote` leased on both
 * reviewed objects. The Tags tab, the sidebar's moved-tag chip and the
 * lineage's moved and published chips all come here, so they ask the same
 * question and write the same way.
 *
 * Resolves `"taken"`, `"cancelled"` (the confirm was declined) or `"failed"`
 * (already reported in a toast).
 */
export async function takePublishedTag(input: {
  repoId: string;
  name: string;
  local: TakeLocal | null;
  published: RemoteTagValue;
  /** Runs after the confirm, before the write: a row can show it is busy. */
  onConfirmed?: () => void;
}): Promise<"taken" | "cancelled" | "failed"> {
  const { repoId, name, local, published } = input;
  const remote = published.remote;
  if (local !== null) {
    const confirmed = await confirmDialog({
      title: `Replace local tag ${name} with ${remote}'s?`,
      message:
        `Local ${name} points at ${local.targetId.slice(0, 12)} (${local.kind}). ` +
        `${remote}'s points at ${published.targetId.slice(0, 12)} (${published.kind}). ` +
        `PwrGit fetches only this tag from ${remote}. Your current tag is kept as ` +
        `refs/pwrgit/replaced-tags/…/${name}, and Restore in the tag's details puts it back.`,
      confirmLabel: `Take ${remote}'s`
    });
    if (!confirmed) return "cancelled";
  } else if (!(await publishedAvailable(repoId, name, published))) {
    const confirmed = await confirmDialog({
      title: `Download ${remote}'s ${name}?`,
      message:
        `Its commit ${published.targetId.slice(0, 12)} is not in this repository. Downloading fetches ` +
        "this one tag and the history it points at — nothing else. That history may be large or unrelated to your branches.",
      confirmLabel: "Download tag"
    });
    if (!confirmed) return "cancelled";
  }
  input.onConfirmed?.();
  const result = await dispatch("tag:adoptRemote", {
    repoId,
    name,
    remote,
    expectedRemoteObjectId: published.objectId,
    expectedLocalObjectId: local?.objectId ?? null
  });
  if (!result.ok) {
    // The remote moved since the check that drew this mark: list it again so
    // the marks show its value now, instead of offering the same refused Take.
    if (result.error.code === "remote_tag_changed" || result.error.code === "remote_tag_missing") {
      void dispatch("tag:refreshRemote", { repoId, remote, mode: "explicit" });
    }
    if (result.error.code !== "canceled") {
      showErrorToast({
        title: local === null ? "Download tag failed" : "Take tag failed",
        message: result.error.message.split("\n")[0],
        detail: result.error.message,
        subject: { repoId, remote: { name: remote } }
      });
    }
    return "failed";
  }
  showInfoToast({
    title: local === null ? `Downloaded ${name}` : `Took ${remote}'s ${name}`,
    message:
      result.value.replacedRef === null
        ? result.value.targetId.slice(0, 12)
        : `${result.value.targetId.slice(0, 12)} · previous value kept as ${result.value.replacedRef}`,
    subject: { repoId, remote: { name: remote } }
  });
  return "taken";
}
