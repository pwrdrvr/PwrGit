import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createPortal } from "react-dom";
import { ContextMenu } from "../shell/ContextMenu";
import { buildImageCopyMenu, useCopyNote } from "./image-copy-menu";
import { referenceExtent, type Extent } from "./image-layout";
import {
  buildSequence,
  itemsForFile,
  stepStop,
  type ItemKind,
  type SideKey
} from "./lightbox-sequence";
import type { DiffFile } from "./parse-diff";
import { planDiff } from "./pixel-diff";
import { computePixelDiff } from "./pixel-diff-client";
import { usePixelDiff } from "./use-pixel-diff";
import {
  sourceOf,
  useImageRevisions,
  type ImageDiffRevisions,
  type SideSeed,
  type SideState
} from "./use-image-revisions";
import { useZoomPan } from "./use-zoom-pan";
import { useFocusTrap } from "../../lib/useFocusTrap";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";

const ITEM_LABEL: Record<ItemKind, string> = {
  before: "Before",
  after: "After",
  diff: "Diff"
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a side that produced no picture should say in the meta line. */
function noteFor(state: SideState): string {
  switch (state.kind) {
    case "loading":
      return "Loading…";
    case "missing":
      return "Not in this revision";
    case "tooLarge":
      return "Too large to preview";
    case "lfsPointer":
      return "Git LFS pointer";
    case "failed":
      return "Could not read the image";
    default:
      return "";
  }
}

/**
 * Full-size viewer for the diff's images: every file's before, after and a
 * pixel diff of the two, under ONE zoom and pan.
 *
 * The shared viewport is the feature. Two pictures side by side answer "did
 * anything change"; only flipping between them on the same pixels at the same
 * magnification answers "what". So the arrows change position and nothing else
 * — Fit and 100% are the only controls that move the view.
 *
 * The arrows run one flat walk across the whole diff — before, after, diff,
 * then straight into the next image file — and stop dead at either end rather
 * than wrapping, because an arrow that quietly starts you over is how you lose
 * track of whether you have seen everything.
 *
 * Portaled to <body> so it escapes `.diff-file`'s `overflow: clip`.
 */
export function ImageLightbox({
  files,
  revisions,
  at,
  seed,
  onMove,
  onClose
}: {
  /** Every image file in the diff, in the order the viewer lists them. */
  files: readonly DiffFile[];
  revisions: ImageDiffRevisions;
  /** Position in the flat walk. */
  at: number;
  seed?: SideSeed | undefined;
  onMove: (at: number) => void;
  onClose: () => void;
}) {
  const tip = useViewportTooltip();
  const sequence = useMemo(() => buildSequence(files), [files]);
  const position = Math.min(Math.max(0, at), Math.max(0, sequence.length - 1));
  const stop = sequence[position];
  const file = stop === undefined ? null : (files[stop.fileIndex] ?? null);
  const item: ItemKind = stop?.item ?? "before";

  const states = useImageRevisions({ file, revisions, enabled: true, seed });

  // The row usually measured both sides before anything could be clicked, but
  // it is not required to have — and a file reached by walking was never on
  // screen at all. Measuring here as well means one code path. Keyed by path
  // so a walk does not carry the previous picture's dimensions forward.
  const [seen, setSeen] = useState<Record<string, Extent>>({});
  const path = file?.path ?? "";
  // Side first so the separator is unambiguous whatever the path contains.
  const seenKey = (side: SideKey): string => `${side}:${path}`;
  const extentOf = (side: SideKey): Extent | null => seen[seenKey(side)] ?? null;
  const measure = useCallback((cell: string, image: HTMLImageElement) => {
    const next = { w: image.naturalWidth, h: image.naturalHeight };
    if (next.w === 0 || next.h === 0) return;
    setSeen((prev) =>
      prev[cell]?.w === next.w && prev[cell]?.h === next.h
        ? prev
        : { ...prev, [cell]: next }
    );
  }, []);

  const beforeExtent = extentOf("before");
  const afterExtent = extentOf("after");
  // Built once per fetch: `sourceOf` concatenates the entire base64 payload,
  // and these go straight into usePixelDiff's dependency array.
  const { before: beforeSrc, after: afterSrc } = useMemo(
    () => ({
      before: sourceOf(states.before),
      after: sourceOf(states.after)
    }),
    [states]
  );

  const reference = useMemo(
    () => referenceExtent([beforeExtent, afterExtent]),
    [beforeExtent, afterExtent]
  );
  // null until the user disagrees with what the shapes imply.
  const [stretch, setStretch] = useState<boolean | null>(null);
  const plan = useMemo(
    () =>
      beforeExtent === null || afterExtent === null
        ? null
        : planDiff(beforeExtent, afterExtent, stretch ?? undefined),
    [beforeExtent, afterExtent, stretch]
  );

  // Latched per file, not per visit: comparing a retina pair costs a few
  // hundred milliseconds and before → diff → after → diff is exactly what this
  // viewer is for. Keyed by path so walking past a file whose diff you never
  // opened does not quietly compare it anyway.
  const [diffed, setDiffed] = useState<Record<string, true>>({});
  useEffect(() => {
    if (item !== "diff" || path === "") return;
    setDiffed((prev) => (prev[path] === true ? prev : { ...prev, [path]: true }));
  }, [item, path]);

  const diff = usePixelDiff({
    enabled: diffed[path] === true,
    before: beforeSrc,
    after: afterSrc,
    plan
  });

  const { stageRef, view, atFit, fit, actual, zoomBy, onPointerDown, panning } =
    useZoomPan(reference);

  const step = useCallback(
    (by: number) => onMove(stepStop(sequence, position, by)),
    [onMove, sequence, position]
  );

  // Focused on open so this is a real modal: a screen reader lands in it, and
  // DiffPane's Escape — scoped to focus being inside the pane, where the button
  // that opened this lives — stops firing behind it.
  const frameRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement;
    frameRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener instanceof HTMLElement) opener.focus({ preventScroll: true });
    };
  }, []);
  // aria-modal alone kept nothing in: Tab walked off the zoom controls into
  // the diff behind the scrim. Declared after the effect above, so focus is
  // already on the frame when the trap's initial focus runs, and that focus is
  // a no-op rather than a second, scrolling one. The copy menu portals outside
  // the frame; Tab there closes it, and the trap lands focus back in here.
  useFocusTrap({ open: true, containerRef: frameRef, initialFocusRef: frameRef });

  // `click` fires on the common ancestor of press and release, so a pan that
  // starts on the image and ends past the frame — easy at any real zoom —
  // would otherwise dismiss the viewer. The scrim only counts as clicked when
  // it was both pressed and released on its own.
  const pressedScrim = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [note, say] = useCopyNote();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The copy menu is an overlay of our own, and it owns every key while it
      // is up. Without this the lightbox answered Escape first — its listener
      // is registered earlier — so dismissing the menu threw away the zoom,
      // the pan and the position in the walk. Exactly the defect this file's
      // AGENTS.md records against DiffPane, one layer further in.
      if (menu !== null) return;
      if (event.key === "Escape") {
        // Claims the key, per the contract DiffPane documents.
        event.preventDefault();
        onClose();
        return;
      }
      // Everything below is a bare key. Cmd/Ctrl+= and Cmd+- are Electron's
      // own window zoom, and answering both at once zooms the window AND the
      // picture — so a held modifier means the shortcut is not ours.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          step(-1);
          return;
        case "ArrowRight":
          event.preventDefault();
          step(1);
          return;
        case "0":
          fit();
          return;
        case "1":
          actual();
          return;
        case "+":
        case "=":
          zoomBy(1.35);
          return;
        case "-":
          zoomBy(1 / 1.35);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [step, onClose, fit, actual, zoomBy, menu]);

  const stopPan = useCallback((event: ReactPointerEvent) => {
    event.stopPropagation();
  }, []);

  if (typeof document === "undefined" || file === null || stop === undefined) {
    return null;
  }

  const items = itemsForFile(file);
  const side = item === "before" ? states.before : states.after;
  const sideSrc = item === "before" ? beforeSrc : afterSrc;
  const sideExtent = item === "before" ? beforeExtent : afterExtent;
  const meta =
    item === "diff"
      ? diff.kind === "ready"
        ? `${((diff.changed / diff.total) * 100).toFixed(2)}% changed · ${diff.changed.toLocaleString()} px`
        : diff.kind === "failed"
          ? `Could not compare — ${diff.reason}`
          : ""
      : sideSrc === null
        ? noteFor(side)
        : `${sideExtent === null ? "" : `${sideExtent.w}×${sideExtent.h} · `}${side.kind === "image" ? formatBytes(side.bytes) : ""}`;
  // `stretch` draws each revision across the whole reference box; `anchor`
  // draws it at natural size in the corner, which is what the diff itself did.
  const fills = plan === null || plan.fit === "stretch";

  const makeDiff =
    beforeSrc !== null &&
    afterSrc !== null &&
    beforeExtent !== null &&
    afterExtent !== null
      ? async (): Promise<Blob> => {
          if (diff.kind === "ready") return diff.png;
          const fresh = planDiff(
            beforeExtent,
            afterExtent,
            stretch ?? undefined
          );
          const result = await computePixelDiff({
            before: beforeSrc,
            after: afterSrc,
            width: fresh.size.w,
            height: fresh.size.h,
            fit: fresh.fit
          });
          return result.png;
        }
      : null;

  const goToItem = (kind: ItemKind) => {
    const target = sequence.findIndex(
      (candidate) =>
        candidate.fileIndex === stop.fileIndex && candidate.item === kind
    );
    if (target !== -1) onMove(target);
  };

  return createPortal(
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${file.path}, expanded`}
      onPointerDown={(event) => {
        pressedScrim.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressedScrim.current && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="image-lightbox__frame" ref={frameRef} tabIndex={-1}>
        <div className="image-lightbox__top">
          {items.length > 1 && (
            <div className="image-lightbox__items" role="tablist">
              {items.map((kind) => (
                <button
                  type="button"
                  key={kind}
                  role="tab"
                  aria-selected={kind === item}
                  className={`image-lightbox__item${kind === item ? " is-on" : ""}`}
                  onClick={() => goToItem(kind)}
                >
                  {ITEM_LABEL[kind]}
                </button>
              ))}
            </div>
          )}
          <span
            className="image-lightbox__path"
            {...hoverTooltip(tip, file.path)}
          >
            {file.path}
          </span>
          <button
            type="button"
            className="image-lightbox__close"
            onClick={onClose}
            aria-label="Close"
            {...hoverTooltip(tip, "Close (Esc)")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {item === "diff" && plan?.mismatch != null && (
          <div className="image-lightbox__note">
            <span>
              <b>Sizes differ</b> — {plan.mismatch.before.w}×
              {plan.mismatch.before.h} against {plan.mismatch.after.w}×
              {plan.mismatch.after.h}. Compared at the larger size.
            </span>
            {plan.canStretch && (
              <label className="image-lightbox__toggle">
                <input
                  type="checkbox"
                  checked={plan.fit === "stretch"}
                  onChange={(event) => setStretch(event.target.checked)}
                />
                Scale to match
              </label>
            )}
          </div>
        )}

        <div
          className={`image-lightbox__stage${panning ? " is-panning" : ""}`}
          ref={stageRef}
          onPointerDown={onPointerDown}
          onDoubleClick={() => (atFit ? actual() : fit())}
          onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => {
            if (beforeSrc === null && afterSrc === null) return;
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          <div
            className="image-lightbox__canvas"
            style={
              reference === null
                ? undefined
                : {
                    width: `${reference.w}px`,
                    height: `${reference.h}px`,
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                    // Past 2x the honest thing is to show the pixels, not
                    // Chromium's guess at what was between them.
                    imageRendering: view.scale > 2 ? "pixelated" : "auto"
                  }
            }
          >
            {/* BOTH revisions are mounted, and the inactive one merely
                hidden. Rendering only the visible side meant the other was
                never decoded, so its dimensions were unknown — and the pixel
                diff needs both to plan a comparison at all. Jumping straight
                to Diff from the tabs therefore produced nothing, silently.
                Keeping both mounted also makes switching instant. */}
            {(["before", "after"] as SideKey[]).map((kind) => {
              const src = kind === "before" ? beforeSrc : afterSrc;
              const extent = kind === "before" ? beforeExtent : afterExtent;
              if (src === null) return null;
              const shown = item === kind;
              return (
                <img
                  key={kind}
                  className={`image-lightbox__img${fills ? " is-fill" : ""}${shown ? "" : " is-hidden"}`}
                  src={src}
                  alt={`${file.path}, ${kind}`}
                  aria-hidden={shown ? undefined : true}
                  draggable={false}
                  onLoad={(event) => measure(seenKey(kind), event.currentTarget)}
                  style={
                    fills || extent === null
                      ? undefined
                      : { width: `${extent.w}px`, height: `${extent.h}px` }
                  }
                />
              );
            })}
            {diff.kind === "ready" && (
              <img
                className={`image-lightbox__img is-fill${item === "diff" ? "" : " is-hidden"}`}
                src={diff.src}
                alt={`${file.path}, pixel diff`}
                aria-hidden={item === "diff" ? undefined : true}
                draggable={false}
              />
            )}
          </div>
          {item === "diff" && diff.kind === "working" && (
            <span className="image-lightbox__busy">Comparing…</span>
          )}
          {sequence.length > 1 && (
            <>
              <button
                type="button"
                className="image-lightbox__nav image-lightbox__nav--prev"
                onClick={() => step(-1)}
                onPointerDown={stopPan}
                disabled={position === 0}
                aria-label="Previous"
                {...hoverTooltip(tip, "Previous (Left Arrow)")}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
              <button
                type="button"
                className="image-lightbox__nav image-lightbox__nav--next"
                onClick={() => step(1)}
                onPointerDown={stopPan}
                disabled={position >= sequence.length - 1}
                aria-label="Next"
                {...hoverTooltip(tip, "Next (Right Arrow)")}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            </>
          )}
        </div>

        <div className="image-lightbox__foot">
          {sequence.length > 1 && (
            <span className="image-lightbox__pos">
              <b>{position + 1}</b> / {sequence.length} · {ITEM_LABEL[item]}
              {files.length > 1 &&
                ` · file ${stop.fileIndex + 1}/${files.length}`}
            </span>
          )}
          <span className="image-lightbox__meta">{note ?? meta}</span>
          {note === null && item === "diff" && diff.kind === "ready" && (
            <span className="image-lightbox__legend">
              <span className="image-lightbox__swatch is-changed" />
              changed
              <span className="image-lightbox__swatch is-aa" />
              anti-aliased
            </span>
          )}
          <span className="image-lightbox__zoom">
            <button
              type="button"
              className={atFit ? "is-on" : ""}
              onClick={fit}
              {...hoverTooltip(tip, "Fit (0)")}
            >
              Fit
            </button>
            <button
              type="button"
              onClick={actual}
              {...hoverTooltip(tip, "Actual size (1)")}
            >
              100%
            </button>
            <button
              type="button"
              onClick={() => zoomBy(1 / 1.35)}
              aria-label="Zoom out"
              {...hoverTooltip(tip, "Zoom out (−)")}
            >
              −
            </button>
            <button
              type="button"
              onClick={() => zoomBy(1.35)}
              aria-label="Zoom in"
              {...hoverTooltip(tip, "Zoom in (+)")}
            >
              +
            </button>
            <span className="image-lightbox__pct">
              {Math.round(view.scale * 100)}%
            </span>
          </span>
        </div>
      </div>
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Copy ${file.path}`}
          items={buildImageCopyMenu({
            before:
              beforeSrc === null ? null : { label: "before", src: beforeSrc },
            after: afterSrc === null ? null : { label: "after", src: afterSrc },
            diff: makeDiff,
            onResult: say
          })}
          onClose={() => setMenu(null)}
        />
      )}
      {tip.tooltipNode}
    </div>,
    document.body
  );
}
