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

/** A side that arrived as a picture: the bytes, and the URL an <img> loads.
 *  `blob.size` and `blob.type` are the file's size and media type. */
export type ShownImage = { kind: "image"; blob: Blob; src: string };

export type SideState =
  | ShownImage
  | Exclude<ImagePreview, { kind: "image" }>
  | { kind: "loading" }
  | { kind: "failed" };
export type SideStates = Record<SideKey, SideState>;

/** Previews a caller already holds, so opening the lightbox on a row whose
 *  picture is already on screen does not blank it while IPC repeats the work.
 *  Only the Blob is reused — never the caller's URL, which the caller owns and
 *  may revoke while the lightbox is still open. */
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
  return state.kind === "image" ? state.src : null;
}

export function blobOf(state: SideState): Blob | null {
  return state.kind === "image" ? state.blob : null;
}

/**
 * Bytes for both sides of one image file. Shared by the inline row and the
 * lightbox: the lightbox walks across files, so it has to be able to fetch a
 * file that the row it was opened from knows nothing about.
 *
 * Every object URL is minted inside the effect run that revokes it, and only
 * there. That is the whole ownership rule, and it is what keeps StrictMode
 * honest: its rehearsal unmount runs this cleanup and then the effect again,
 * so the URLs the first run made are revoked and the second run makes the
 * ones that end up on screen. A URL minted anywhere else — a `useMemo`, a
 * store built during render — would be revoked by that rehearsal while the
 * component went on showing it.
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
    const minted: string[] = [];
    const show = (blob: Blob): ShownImage => {
      const src = URL.createObjectURL(blob);
      minted.push(src);
      return { kind: "image", blob, src };
    };
    const cleanup = () => {
      active = false;
      // A superseded run's pictures go with it: walking the lightbox through
      // a diff would otherwise pin every revision it ever showed.
      for (const src of minted) URL.revokeObjectURL(src);
    };

    // A seed only counts for the file it was taken from — walking to the next
    // picture must not show the previous one while the bytes arrive.
    const seeded = seed !== undefined && seed.path === file.path;
    const reuse = (state: SideState): SideState =>
      state.kind === "image" ? show(state.blob) : state;
    const start: SideStates = seeded
      ? { before: reuse(seed.states.before), after: reuse(seed.states.after) }
      : LOADING;
    setStates(start);
    if (!enabled) return cleanup;

    for (const side of sidesFor(file.status, beforePath)) {
      if (start[side].kind === "image") continue;
      const path = side === "before" ? beforePath : file.path;
      void dispatch("diff:image", {
        worktreeId: revisions.worktreeId,
        path,
        rev: side === "before" ? revisions.before : revisions.after
      }).then((result) => {
        // Nothing is minted for a reply that lands after cleanup, so nothing
        // is left for a cleanup that has already run.
        if (!active) return;
        const next: SideState = !result.ok
          ? { kind: "failed" }
          : result.value.kind === "image"
            ? show(
                new Blob([result.value.bytes], { type: result.value.mediaType })
              )
            : result.value;
        setStates((prev) => ({ ...prev, [side]: next }));
      });
    }
    return cleanup;
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
