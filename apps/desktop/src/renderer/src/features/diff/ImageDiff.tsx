import { useEffect, useState } from "react";
import type { ImagePreview, ImageRevision } from "@pwrgit/shared";
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

/** Which sides are worth fetching — an added file has no "before". */
function sidesFor(status: DiffFile["status"]): SideKey[] {
  if (status === "added") return ["after"];
  if (status === "deleted") return ["before"];
  return ["before", "after"];
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
  const sides = sidesFor(file.status);
  // Renames move the bytes: the old revision only knows the old path.
  const beforePath = file.oldPath ?? file.path;
  const [state, setState] = useState<Record<SideKey, SideState>>({
    before: { kind: "loading" },
    after: { kind: "loading" }
  });

  useEffect(() => {
    let active = true;
    setState({ before: { kind: "loading" }, after: { kind: "loading" } });
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
    revisions.worktreeId,
    revisionKey(revisions.before),
    revisionKey(revisions.after),
    beforePath,
    file.path,
    file.status
  ]);

  return (
    <div className="diff-image">
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
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  return (
    <figure className="diff-image__side">
      <figcaption className="diff-image__label">{label}</figcaption>
      <div className="diff-image__frame">
        <ImageBody path={path} label={label} state={state} onSize={setSize} />
      </div>
      <div className="diff-image__meta">
        {state.kind === "image"
          ? `${size === null ? "" : `${size.w}×${size.h} · `}${formatBytes(state.bytes)}`
          : ""}
      </div>
    </figure>
  );
}

function ImageBody({
  path,
  label,
  state,
  onSize
}: {
  path: string;
  label: string;
  state: SideState;
  onSize: (size: { w: number; h: number }) => void;
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
          src={`data:${state.mediaType};base64,${state.base64}`}
          alt={`${path}, ${label}`}
          onLoad={(e) =>
            onSize({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight
            })
          }
        />
      );
  }
}
