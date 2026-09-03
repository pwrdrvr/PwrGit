import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject
} from "react";
import { ContextMenu } from "../shell/ContextMenu";
import { buildImageCopyMenu, useCopyNote } from "./image-copy-menu";
import { ROW_PADDING, shouldStack, type Extent } from "./image-layout";
import { sidesFor, type SideKey } from "./lightbox-sequence";
import { planDiff } from "./pixel-diff";
import { computePixelDiff } from "./pixel-diff-client";
import type { DiffFile } from "./parse-diff";
import {
  sourceOf,
  useImageRevisions,
  type ImageDiffRevisions,
  type SideState,
  type SideStates
} from "./use-image-revisions";

export type { ImageDiffRevisions } from "./use-image-revisions";

/** Decoded dimensions, tagged with the source they were measured from. */
type Measured = Extent & { src: string };

const SIDE_LABEL: Record<SideKey, string> = {
  before: "before",
  after: "after"
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
 *
 * The lightbox is NOT owned here. It walks across every image file in the
 * diff, and a row only knows its own, so `onOpen` hands the request up to
 * DiffViewer along with the bytes this row already holds — which is what keeps
 * the picture on screen instead of blanking while IPC repeats itself.
 */
export function ImageDiff({
  file,
  revisions,
  onOpen
}: {
  file: DiffFile;
  revisions: ImageDiffRevisions;
  onOpen?: (item: SideKey, states: SideStates) => void;
}) {
  // Renames move the bytes: the old revision only knows the old path.
  const beforePath = file.oldPath ?? file.path;
  const sides = sidesFor(file.status, beforePath);
  const [host, near] = useNearViewport();
  const states = useImageRevisions({ file, revisions, enabled: near });
  // Measured dimensions carry the source they were measured from. Bytes that
  // never decode fire no `load`, so an unqualified size would keep reporting
  // whatever the side showed previously.
  const [sizes, setSizes] = useState<Record<SideKey, Measured | null>>({
    before: null,
    after: null
  });
  const [rowWidth, setRowWidth] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [note, say] = useCopyNote();

  // The container query in app.css settles the axis at first paint from width
  // alone; this refines it once the aspect ratios are known, because a banner
  // and a phone screenshot want different answers at the same pane width.
  useEffect(() => {
    const node = host.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setRowWidth(node.clientWidth - ROW_PADDING * 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [host]);

  // `sourceOf` concatenates the whole base64 payload — up to ~21 MB at the
  // preview ceiling — so it is built ONCE per fetch rather than on each of the
  // eight or so calls a render used to make. The stable identity matters twice
  // over: usePixelDiff keeps these in an effect dependency array, where a
  // fresh-but-equal string costs a full-length comparison every render.
  const srcs = useMemo(
    (): Record<SideKey, string | null> => ({
      before: sourceOf(states.before),
      after: sourceOf(states.after)
    }),
    [states]
  );

  const extentOf = (side: SideKey): Extent | null => {
    const size = sizes[side];
    return size !== null && size.src === srcs[side] ? size : null;
  };
  const stacked =
    sides.length === 2 &&
    shouldStack(rowWidth, [extentOf("before"), extentOf("after")]);

  const copySource = (side: SideKey) => {
    const src = srcs[side];
    return src === null ? null : { label: SIDE_LABEL[side], src };
  };
  const beforeExtent = extentOf("before");
  const afterExtent = extentOf("after");
  const beforeSrc = srcs.before;
  const afterSrc = srcs.after;
  // Copying the diff from the row runs the same comparison the lightbox does;
  // there is no reason to make the reader open the viewer to reach it.
  const makeDiff =
    beforeExtent !== null &&
    afterExtent !== null &&
    beforeSrc !== null &&
    afterSrc !== null
      ? async (): Promise<Blob> => {
          const plan = planDiff(beforeExtent, afterExtent);
          const result = await computePixelDiff({
            before: beforeSrc,
            after: afterSrc,
            width: plan.size.w,
            height: plan.size.h,
            fit: plan.fit
          });
          return result.png;
        }
      : null;

  return (
    <div
      className={`diff-image${stacked ? " diff-image--stacked" : ""}`}
      ref={host}
      onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (beforeSrc === null && afterSrc === null) return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {sides.map((side) => (
        <ImageSide
          key={side}
          label={SIDE_LABEL[side]}
          path={side === "before" ? beforePath : file.path}
          state={states[side]}
          src={srcs[side]}
          measured={extentOf(side)}
          note={note}
          onSize={(size) => setSizes((prev) => ({ ...prev, [side]: size }))}
          {...(onOpen === undefined
            ? {}
            : { onOpen: () => onOpen(side, states) })}
        />
      ))}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Copy ${file.path}`}
          items={buildImageCopyMenu({
            before: copySource("before"),
            after: copySource("after"),
            diff: makeDiff,
            onResult: say
          })}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function ImageSide({
  label,
  path,
  state,
  src,
  measured,
  note,
  onSize,
  onOpen
}: {
  label: string;
  path: string;
  state: SideState;
  /** Passed in rather than derived: see the `srcs` memo above. */
  src: string | null;
  measured: Extent | null;
  note: string | null;
  onSize: (size: Measured) => void;
  onOpen?: () => void;
}) {
  return (
    <figure className="diff-image__side">
      <figcaption className="diff-image__label">{label}</figcaption>
      {state.kind === "image" && onOpen !== undefined ? (
        <button
          type="button"
          className="diff-image__frame"
          onClick={onOpen}
          title="Open (zoom, pan, compare) · right-click to copy"
        >
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
          <span className="diff-image__open" aria-hidden="true">
            Open
          </span>
        </button>
      ) : (
        <div className="diff-image__frame diff-image__frame--flat">
          {state.kind === "image" ? (
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
          ) : (
            <ImageNote state={state} />
          )}
        </div>
      )}
      <div className="diff-image__meta">
        {note !== null ? (
          <span className="diff-image__copied">{note}</span>
        ) : state.kind === "image" ? (
          `${measured === null ? "" : `${measured.w}×${measured.h} · `}${formatBytes(state.bytes)}`
        ) : (
          ""
        )}
      </div>
    </figure>
  );
}

function ImageNote({ state }: { state: SideState }) {
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
    default:
      return null;
  }
}
