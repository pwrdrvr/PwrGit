import { useEffect, useRef, useState, type RefObject } from "react";
import {
  imageMediaType,
  type ImagePreview,
  type ImageRevision
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import type { DiffFile } from "./parse-diff";

/** The two revisions a diff compares, so an image row can fetch both sides. */
export type ImageDiffRevisions = {
  worktreeId: string;
  before: ImageRevision;
  after: ImageRevision;
};

type SideKey = "before" | "after";

type SideState = ImagePreview | { kind: "loading" } | { kind: "failed" };

/** Decoded dimensions, tagged with the source they were measured from. */
type Measured = { src: string; w: number; h: number };

const SIDE_LABEL: Record<SideKey, string> = {
  before: "before",
  after: "after"
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Stable dependency key — the revisions object is rebuilt every render. */
function revisionKey(rev: ImageRevision): string {
  return rev.kind === "commit" || rev.kind === "commitParent"
    ? `${rev.kind}:${rev.hash}`
    : rev.kind;
}

/**
 * Which sides are worth fetching. An added file has no "before"; neither does
 * a rename out of a non-image extension (`logo.bin` → `logo.png`), where the
 * old blob is not something an <img> can show.
 */
function sidesFor(status: DiffFile["status"], beforePath: string): SideKey[] {
  if (status === "deleted") return ["before"];
  if (status === "added" || imageMediaType(beforePath) === null) {
    return ["after"];
  }
  return ["before", "after"];
}

/**
 * A whole-commit diff renders every file it touched, so fetching on mount
 * would pull each image's bytes — up to 16 MB apiece, base64'd — for pictures
 * scrolled far off screen. Wait until the row is near the viewport.
 */
function useNearViewport(): [RefObject<HTMLDivElement | null>, boolean] {
  const host = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = host.current;
    // No observer (jsdom, very old engines) means no way to defer: fetch now
    // rather than leave the row blank forever.
    if (node === null || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [host, near];
}

/**
 * Preview of a binary image file in a diff. Git has no line-level answer for
 * these, so both revisions are fetched as bytes and handed to Chromium, which
 * already decodes every format the repository is likely to hold.
 */
export function ImageDiff({
  file,
  revisions
}: {
  file: DiffFile;
  revisions: ImageDiffRevisions;
}) {
  // Renames move the bytes: the old revision only knows the old path.
  const beforePath = file.oldPath ?? file.path;
  const sides = sidesFor(file.status, beforePath);
  const [host, near] = useNearViewport();
  const [state, setState] = useState<Record<SideKey, SideState>>({
    before: { kind: "loading" },
    after: { kind: "loading" }
  });

  useEffect(() => {
    let active = true;
    setState({ before: { kind: "loading" }, after: { kind: "loading" } });
    if (!near) return;
    for (const side of sides) {
      const path = side === "before" ? beforePath : file.path;
      void dispatch("diff:image", {
        worktreeId: revisions.worktreeId,
        path,
        rev: side === "before" ? revisions.before : revisions.after
      }).then((result) => {
        if (!active) return;
        setState((prev) => ({
          ...prev,
          [side]: result.ok ? result.value : { kind: "failed" }
        }));
      });
    }
    return () => {
      active = false;
    };
    // Paths and revisions fully determine the fetch; `sides` derives from them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    near,
    revisions.worktreeId,
    revisionKey(revisions.before),
    revisionKey(revisions.after),
    beforePath,
    file.path,
    file.status
  ]);

  return (
    <div className="diff-image" ref={host}>
      {sides.map((side) => (
        <ImageSide
          key={side}
          label={SIDE_LABEL[side]}
          path={side === "before" ? beforePath : file.path}
          state={state[side]}
        />
      ))}
    </div>
  );
}

function ImageSide({
  label,
  path,
  state
}: {
  label: string;
  path: string;
  state: SideState;
}) {
  const src =
    state.kind === "image"
      ? `data:${state.mediaType};base64,${state.base64}`
      : null;
  // Measured dimensions carry the source they were measured from. Bytes that
  // never decode fire no `load`, so an unqualified size would keep reporting
  // whatever the side showed previously.
  const [size, setSize] = useState<Measured | null>(null);
  const measured = size !== null && size.src === src ? size : null;
  return (
    <figure className="diff-image__side">
      <figcaption className="diff-image__label">{label}</figcaption>
      <div className="diff-image__frame">
        <ImageBody
          src={src}
          path={path}
          label={label}
          state={state}
          onSize={setSize}
        />
      </div>
      <div className="diff-image__meta">
        {state.kind === "image"
          ? `${measured === null ? "" : `${measured.w}×${measured.h} · `}${formatBytes(state.bytes)}`
          : ""}
      </div>
    </figure>
  );
}

function ImageBody({
  src,
  path,
  label,
  state,
  onSize
}: {
  src: string | null;
  path: string;
  label: string;
  state: SideState;
  onSize: (size: Measured) => void;
}) {
  switch (state.kind) {
    case "loading":
      return <span className="diff-image__note">Loading…</span>;
    case "missing":
      return <span className="diff-image__note">Not in this revision</span>;
    case "tooLarge":
      return (
        <span className="diff-image__note">
          {formatBytes(state.bytes)} — too large to preview
        </span>
      );
    case "lfsPointer":
      return (
        <span className="diff-image__note">
          Git LFS pointer — run `git lfs pull` to see the image
        </span>
      );
    case "failed":
      return <span className="diff-image__note">Could not read the image</span>;
    case "image":
      return (
        <img
          className="diff-image__img"
          src={src ?? ""}
          alt={`${path}, ${label}`}
          onLoad={(e) =>
            onSize({
              src: e.currentTarget.getAttribute("src") ?? "",
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight
            })
          }
        />
      );
  }
}
