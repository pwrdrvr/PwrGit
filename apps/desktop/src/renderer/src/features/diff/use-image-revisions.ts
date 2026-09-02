import { useEffect, useState } from "react";
import type { ImagePreview, ImageRevision } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { sidesFor, type SideKey } from "./lightbox-sequence";
import type { DiffFile } from "./parse-diff";

/** The two revisions a diff compares, so an image row can fetch both sides. */
export type ImageDiffRevisions = {
  worktreeId: string;
  before: ImageRevision;
  after: ImageRevision;
};

export type SideState = ImagePreview | { kind: "loading" } | { kind: "failed" };
export type SideStates = Record<SideKey, SideState>;

/** Previews a caller already holds, so opening the lightbox on a row whose
 *  picture is already on screen does not blank it while IPC repeats the work. */
export type SideSeed = { path: string; states: SideStates };

const LOADING: SideStates = {
  before: { kind: "loading" },
  after: { kind: "loading" }
};

/** Stable dependency key — the revisions object is rebuilt every render. */
function revisionKey(rev: ImageRevision): string {
  return rev.kind === "commit" || rev.kind === "commitParent"
    ? `${rev.kind}:${rev.hash}`
    : rev.kind;
}

export function sourceOf(state: SideState): string | null {
  return state.kind === "image"
    ? `data:${state.mediaType};base64,${state.base64}`
    : null;
}

/**
 * Bytes for both sides of one image file. Shared by the inline row and the
 * lightbox: the lightbox walks across files, so it has to be able to fetch a
 * file that the row it was opened from knows nothing about.
 */
export function useImageRevisions({
  file,
  revisions,
  enabled,
  seed
}: {
  file: DiffFile | null;
  revisions: ImageDiffRevisions;
  enabled: boolean;
  seed?: SideSeed | undefined;
}): SideStates {
  const [states, setStates] = useState<SideStates>(LOADING);
  const beforePath = file === null ? "" : (file.oldPath ?? file.path);
  const fileKey =
    file === null ? "" : `${file.status} ${beforePath} ${file.path}`;

  useEffect(() => {
    if (file === null) return;
    let active = true;
    // A seed only counts for the file it was taken from — walking to the next
    // picture must not show the previous one while the bytes arrive.
    const seeded = seed !== undefined && seed.path === file.path;
    const start = seeded ? seed.states : LOADING;
    setStates(start);
    if (!enabled) return;
    for (const side of sidesFor(file.status, beforePath)) {
      if (start[side].kind === "image") continue;
      const path = side === "before" ? beforePath : file.path;
      void dispatch("diff:image", {
        worktreeId: revisions.worktreeId,
        path,
        rev: side === "before" ? revisions.before : revisions.after
      }).then((result) => {
        if (!active) return;
        setStates((prev) => ({
          ...prev,
          [side]: result.ok ? result.value : { kind: "failed" }
        }));
      });
    }
    return () => {
      active = false;
    };
    // The file and the revisions fully determine the fetch; `seed` is an
    // initial value, not an input, and re-running on it would refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    fileKey,
    revisions.worktreeId,
    revisionKey(revisions.before),
    revisionKey(revisions.after)
  ]);

  return states;
}
