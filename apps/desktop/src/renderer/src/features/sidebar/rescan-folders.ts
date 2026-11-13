import type { Repo } from "@pwrgit/shared";
import type { Toast } from "../../lib/toast";

/** One key, so "Rescanning…" becomes its answer instead of a second card. */
export const RESCAN_FOLDERS_TOAST_KEY = "rescan-folders";

const NAMED = 4;

const folders = (count: number): string =>
  `${count} ${count === 1 ? "folder" : "folders"}`;

/**
 * What Add ▾ → Rescan folders says when the scan answers. One new
 * repository is named by its chip, which takes you there; several are named
 * in the message, up to four. Nothing new says so, in the reader's terms:
 * the scan looked, and everything it found is already in the sidebar.
 */
export function rescanFoldersToast(
  added: readonly Pick<Repo, "id" | "name">[],
  rootCount: number
): Omit<Toast, "id" | "tone"> {
  const base = { key: RESCAN_FOLDERS_TOAST_KEY, showCopyAction: false };
  const first = added[0];
  if (first === undefined) {
    return {
      ...base,
      title: "No new repositories",
      message: `Looked through ${folders(rootCount)}. Everything there is already listed.`
    };
  }
  if (added.length === 1) {
    // The title is an eyebrow over the chip, and the chip carries the name.
    return {
      ...base,
      title: "New repository",
      message: `Found in ${rootCount === 1 ? "your folder" : `your ${folders(rootCount)}`} and added to the sidebar.`,
      subject: { repoId: first.id }
    };
  }
  const names = added.slice(0, NAMED).map((repo) => repo.name);
  const more = added.length - names.length;
  return {
    ...base,
    title: `${added.length} new repositories`,
    message: more > 0 ? `${names.join(", ")} and ${more} more.` : `${names.join(", ")}.`
  };
}
